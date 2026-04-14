#include <math.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#include "driver/i2s.h"
#include "esp_adc/adc_cali.h"
#include "esp_adc/adc_cali_scheme.h"
#include "esp_adc/adc_oneshot.h"
#include "esp_event.h"
#include "esp_crt_bundle.h"
#include "esp_http_client.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "rom/ets_sys.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include "freertos/task.h"
#include "nvs_flash.h"

#include "lwip/err.h"
#include "lwip/sys.h"

#ifndef CONFIG_SENSOR_OUTPUT_INVERTED
#define CONFIG_SENSOR_OUTPUT_INVERTED 0
#endif

#define WIFI_CONNECTED_BIT BIT0
#define WIFI_FAIL_BIT BIT1

#define SAMPLE_BUFFER_SAMPLES 256
#define TWO_PI 6.28318530718f

static const char *TAG = "pio_station";
static EventGroupHandle_t s_wifi_event_group;
static int s_retry_num = 0;

typedef struct {
    uint32_t seq;
    float raw_mv;
    float filtered_mv;
    float score;
    bool warning;
    bool alarm;
} sensor_state_t;

static sensor_state_t s_sensor_state;
static portMUX_TYPE s_sensor_lock = portMUX_INITIALIZER_UNLOCKED;

static adc_unit_t s_adc_unit = ADC_UNIT_1;
static adc_oneshot_unit_handle_t s_adc_handle;
static adc_cali_handle_t s_adc_cali_handle;
static adc_channel_t s_adc_channel;
static bool s_adc_cali_enabled = false;
static bool s_i2s_enabled = false;
static volatile bool s_alarm_sound_enabled = CONFIG_ALARM_SOUND_ENABLED;
static char s_http_resp_buf[384];
static size_t s_http_resp_len = 0;

static i2s_port_t s_i2s_port = I2S_NUM_0;
static int64_t s_last_adc_high_warn_ms = 0;

static int64_t now_ms(void)
{
    return esp_timer_get_time() / 1000;
}

static float clampf_range(float value, float min_value, float max_value)
{
    if (value < min_value) {
        return min_value;
    }
    if (value > max_value) {
        return max_value;
    }
    return value;
}

static sensor_state_t copy_sensor_state(void)
{
    sensor_state_t snapshot;
    portENTER_CRITICAL(&s_sensor_lock);
    snapshot = s_sensor_state;
    portEXIT_CRITICAL(&s_sensor_lock);
    return snapshot;
}

static void update_sensor_state(float raw_mv, float filtered_mv, float score)
{
    portENTER_CRITICAL(&s_sensor_lock);
    s_sensor_state.seq += 1;
    s_sensor_state.raw_mv = raw_mv;
    s_sensor_state.filtered_mv = filtered_mv;
    s_sensor_state.score = score;
    s_sensor_state.warning = score >= CONFIG_SENSOR_WARNING_THRESHOLD;
    s_sensor_state.alarm = score >= CONFIG_SENSOR_ALARM_THRESHOLD;
    portEXIT_CRITICAL(&s_sensor_lock);
}

static float score_from_mv(float mv)
{
    float clean_mv = (float)CONFIG_SENSOR_CLEAN_AIR_MV;
    float dense_mv = (float)CONFIG_SENSOR_DENSE_AIR_MV;

    if (fabsf(dense_mv - clean_mv) < 1.0f) {
        return 0.0f;
    }

    float normalized = (mv - clean_mv) / (dense_mv - clean_mv);
#if CONFIG_SENSOR_OUTPUT_INVERTED
    normalized = 1.0f - normalized;
#endif
    normalized = clampf_range(normalized, 0.0f, 1.0f);
    return normalized * (float)CONFIG_SENSOR_SCORE_MAX;
}

static esp_err_t adc_init_sensor(void)
{
    adc_unit_t unit_id = ADC_UNIT_1;
    esp_err_t err = adc_oneshot_io_to_channel(CONFIG_SENSOR_AO_GPIO, &unit_id, &s_adc_channel);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "GPIO %d is not a valid ADC pin", CONFIG_SENSOR_AO_GPIO);
        return err;
    }

    if (unit_id != ADC_UNIT_1 && unit_id != ADC_UNIT_2) {
        ESP_LOGE(TAG, "GPIO %d resolved to unsupported ADC unit %d", CONFIG_SENSOR_AO_GPIO, unit_id);
        return ESP_ERR_INVALID_ARG;
    }
    s_adc_unit = unit_id;

    adc_oneshot_unit_init_cfg_t init_config = {
        .unit_id = s_adc_unit,
        .ulp_mode = ADC_ULP_MODE_DISABLE,
    };
    ESP_ERROR_CHECK(adc_oneshot_new_unit(&init_config, &s_adc_handle));

    adc_oneshot_chan_cfg_t chan_config = {
        .atten = ADC_ATTEN_DB_12,
        .bitwidth = ADC_BITWIDTH_DEFAULT,
    };
    ESP_ERROR_CHECK(adc_oneshot_config_channel(s_adc_handle, s_adc_channel, &chan_config));

#if ADC_CALI_SCHEME_CURVE_FITTING_SUPPORTED
    adc_cali_curve_fitting_config_t cali_config = {
        .unit_id = s_adc_unit,
        .chan = s_adc_channel,
        .atten = ADC_ATTEN_DB_12,
        .bitwidth = ADC_BITWIDTH_DEFAULT,
    };
    if (adc_cali_create_scheme_curve_fitting(&cali_config, &s_adc_cali_handle) == ESP_OK) {
        s_adc_cali_enabled = true;
    }
#elif ADC_CALI_SCHEME_LINE_FITTING_SUPPORTED
    adc_cali_line_fitting_config_t cali_config = {
        .unit_id = s_adc_unit,
        .atten = ADC_ATTEN_DB_12,
        .bitwidth = ADC_BITWIDTH_DEFAULT,
    };
    if (adc_cali_create_scheme_line_fitting(&cali_config, &s_adc_cali_handle) == ESP_OK) {
        s_adc_cali_enabled = true;
    }
#endif

    ESP_LOGI(TAG, "ADC ready on GPIO %d unit=%d channel=%d calibration=%s",
             CONFIG_SENSOR_AO_GPIO,
             (int)s_adc_unit + 1,
             (int)s_adc_channel,
             s_adc_cali_enabled ? "on" : "off");
    return ESP_OK;
}

static float adc_read_mv(void)
{
    const int samples = 16;
    int raw_sum = 0;

    for (int i = 0; i < samples; ++i) {
        int raw = 0;
        if (adc_oneshot_read(s_adc_handle, s_adc_channel, &raw) == ESP_OK) {
            raw_sum += raw;
        }
        ets_delay_us(600);
    }

    int raw_avg = raw_sum / samples;
    int voltage_mv = 0;
    if (s_adc_cali_enabled) {
        if (adc_cali_raw_to_voltage(s_adc_cali_handle, raw_avg, &voltage_mv) == ESP_OK) {
            return (float)voltage_mv;
        }
    }

    return ((float)raw_avg / 4095.0f) * 3300.0f;
}

static esp_err_t audio_init_i2s(void)
{
    i2s_config_t i2s_config = {
        .mode = I2S_MODE_MASTER | I2S_MODE_TX,
        .sample_rate = 16000,
        .bits_per_sample = I2S_BITS_PER_SAMPLE_16BIT,
        .channel_format = I2S_CHANNEL_FMT_RIGHT_LEFT,
        .communication_format = I2S_COMM_FORMAT_STAND_I2S,
        .intr_alloc_flags = 0,
        .dma_buf_count = 6,
        .dma_buf_len = 256,
        .use_apll = false,
        .tx_desc_auto_clear = true,
        .fixed_mclk = 0,
    };

    i2s_pin_config_t pin_config = {
        .bck_io_num = CONFIG_I2S_BCLK_GPIO,
        .ws_io_num = CONFIG_I2S_WS_GPIO,
        .data_out_num = CONFIG_I2S_DOUT_GPIO,
        .data_in_num = I2S_PIN_NO_CHANGE,
        .mck_io_num = I2S_PIN_NO_CHANGE,
    };

    if (i2s_driver_install(s_i2s_port, &i2s_config, 0, NULL) != ESP_OK) {
        ESP_LOGE(TAG, "I2S driver install failed");
        return ESP_FAIL;
    }
    if (i2s_set_pin(s_i2s_port, &pin_config) != ESP_OK) {
        ESP_LOGE(TAG, "I2S set pin failed");
        return ESP_FAIL;
    }
    i2s_zero_dma_buffer(s_i2s_port);

    s_i2s_enabled = true;
    ESP_LOGI(TAG, "I2S ready BCLK=%d WS=%d DOUT=%d",
             CONFIG_I2S_BCLK_GPIO,
             CONFIG_I2S_WS_GPIO,
             CONFIG_I2S_DOUT_GPIO);
    return ESP_OK;
}

static void audio_play_tone(int tone_hz, int duration_ms)
{
    if (!s_i2s_enabled || tone_hz <= 0 || duration_ms <= 0) {
        return;
    }

    const int sample_rate = 16000;
    const int total_samples = (sample_rate * duration_ms) / 1000;
    int16_t buffer[SAMPLE_BUFFER_SAMPLES * 2];
    int generated = 0;
    size_t bytes_written = 0;

    while (generated < total_samples) {
        int chunk = SAMPLE_BUFFER_SAMPLES;
        if (chunk > (total_samples - generated)) {
            chunk = total_samples - generated;
        }

        for (int i = 0; i < chunk; ++i) {
            float phase = TWO_PI * (float)(generated + i) * (float)tone_hz / (float)sample_rate;
            int16_t sample = (int16_t)(sinf(phase) * 1100.0f);
            buffer[i * 2] = sample;
            buffer[i * 2 + 1] = sample;
        }

        i2s_write(s_i2s_port, buffer, chunk * 2 * sizeof(int16_t), &bytes_written, portMAX_DELAY);
        generated += chunk;
    }

    i2s_zero_dma_buffer(s_i2s_port);
}

static void apply_alarm_control_from_response(const char *body)
{
    if (body == NULL) {
        return;
    }

    const char *key = "\"alarm_sound_enabled\"";
    const char *cursor = strstr(body, key);
    if (cursor == NULL) {
        return;
    }

    cursor += strlen(key);
    while (*cursor == ' ' || *cursor == '\t' || *cursor == '\r' || *cursor == '\n' || *cursor == ':') {
        cursor++;
    }

    bool parsed = false;
    bool target = s_alarm_sound_enabled;
    if (strncmp(cursor, "true", 4) == 0 || strncmp(cursor, "1", 1) == 0) {
        parsed = true;
        target = true;
    } else if (strncmp(cursor, "false", 5) == 0 || strncmp(cursor, "0", 1) == 0) {
        parsed = true;
        target = false;
    }

    if (parsed && target != s_alarm_sound_enabled) {
        s_alarm_sound_enabled = target;
        ESP_LOGI(TAG, "remote alarm sound switch updated: %s", target ? "on" : "off");
    }
}

static esp_err_t http_client_event_handler(esp_http_client_event_t *evt)
{
    if (evt == NULL) {
        return ESP_OK;
    }

    if (evt->event_id == HTTP_EVENT_ON_DATA && evt->data != NULL && evt->data_len > 0) {
        size_t remaining = sizeof(s_http_resp_buf) - 1 - s_http_resp_len;
        if (remaining > 0) {
            size_t copy_len = (size_t)evt->data_len;
            if (copy_len > remaining) {
                copy_len = remaining;
            }
            memcpy(s_http_resp_buf + s_http_resp_len, evt->data, copy_len);
            s_http_resp_len += copy_len;
            s_http_resp_buf[s_http_resp_len] = '\0';
        }
    }

    return ESP_OK;
}

static void event_handler(void *arg, esp_event_base_t event_base, int32_t event_id, void *event_data)
{
    if (event_base == WIFI_EVENT && event_id == WIFI_EVENT_STA_START) {
        esp_wifi_connect();
    } else if (event_base == WIFI_EVENT && event_id == WIFI_EVENT_STA_DISCONNECTED) {
        xEventGroupClearBits(s_wifi_event_group, WIFI_CONNECTED_BIT);
        if (s_retry_num < CONFIG_ESP_MAXIMUM_RETRY) {
            esp_wifi_connect();
            s_retry_num++;
            ESP_LOGI(TAG, "retry to connect to the AP");
        } else {
            xEventGroupSetBits(s_wifi_event_group, WIFI_FAIL_BIT);
        }
        ESP_LOGW(TAG, "connect to the AP failed");
    } else if (event_base == IP_EVENT && event_id == IP_EVENT_STA_GOT_IP) {
        ip_event_got_ip_t *event = (ip_event_got_ip_t *)event_data;
        ESP_LOGI(TAG, "got ip:" IPSTR, IP2STR(&event->ip_info.ip));
        s_retry_num = 0;
        xEventGroupSetBits(s_wifi_event_group, WIFI_CONNECTED_BIT);
    }
}

static bool wifi_init_sta(void)
{
    s_wifi_event_group = xEventGroupCreate();

    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());
    esp_netif_create_default_wifi_sta();

    wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&cfg));

    esp_event_handler_instance_t instance_any_id;
    esp_event_handler_instance_t instance_got_ip;
    ESP_ERROR_CHECK(esp_event_handler_instance_register(WIFI_EVENT, ESP_EVENT_ANY_ID, &event_handler, NULL, &instance_any_id));
    ESP_ERROR_CHECK(esp_event_handler_instance_register(IP_EVENT, IP_EVENT_STA_GOT_IP, &event_handler, NULL, &instance_got_ip));

    wifi_config_t wifi_config = {
        .sta = {
            .threshold.authmode = WIFI_AUTH_OPEN,
            .pmf_cfg = {
                .capable = true,
                .required = false
            },
        },
    };

    strlcpy((char *)wifi_config.sta.ssid, CONFIG_ESP_WIFI_SSID, sizeof(wifi_config.sta.ssid));
    strlcpy((char *)wifi_config.sta.password, CONFIG_ESP_WIFI_PASSWORD, sizeof(wifi_config.sta.password));

    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &wifi_config));
    ESP_ERROR_CHECK(esp_wifi_start());

    ESP_LOGI(TAG, "wifi_init_sta finished");

    EventBits_t bits = xEventGroupWaitBits(
        s_wifi_event_group,
        WIFI_CONNECTED_BIT | WIFI_FAIL_BIT,
        pdFALSE,
        pdFALSE,
        portMAX_DELAY);

    if (bits & WIFI_CONNECTED_BIT) {
        ESP_LOGI(TAG, "connected to SSID:%s", CONFIG_ESP_WIFI_SSID);
        return true;
    }

    ESP_LOGE(TAG, "Failed to connect to SSID:%s", CONFIG_ESP_WIFI_SSID);
    return false;
}

static void post_sensor_data_once(void)
{
    sensor_state_t snapshot = copy_sensor_state();
    s_http_resp_len = 0;
    s_http_resp_buf[0] = '\0';

    char json_payload[256];
    snprintf(
        json_payload,
        sizeof(json_payload),
        "{\"device_id\":\"%s\",\"ts_ms\":%lld,\"pollen_value\":%.2f,\"raw_mv\":%.0f,\"filtered_mv\":%.0f,\"seq\":%lu}",
        CONFIG_SENSOR_DEVICE_ID,
        (long long)now_ms(),
        snapshot.score,
        snapshot.raw_mv,
        snapshot.filtered_mv,
        (unsigned long)snapshot.seq);

    esp_http_client_config_t config = {
        .url = CONFIG_SENSOR_POST_URL,
        .method = HTTP_METHOD_POST,
        .timeout_ms = 5000,
        .event_handler = http_client_event_handler,
        // Use the built-in root CA bundle for HTTPS server verification.
        .crt_bundle_attach = esp_crt_bundle_attach,
    };

    esp_http_client_handle_t client = esp_http_client_init(&config);
    if (client == NULL) {
        ESP_LOGE(TAG, "failed to init http client");
        return;
    }

    esp_http_client_set_header(client, "Content-Type", "application/json");
    esp_http_client_set_post_field(client, json_payload, strlen(json_payload));

    esp_err_t err = esp_http_client_perform(client);
    if (err == ESP_OK) {
        int status = esp_http_client_get_status_code(client);
        if (s_http_resp_len > 0) {
            apply_alarm_control_from_response(s_http_resp_buf);
        }
        ESP_LOGI(TAG, "POST status=%d score=%.1f raw=%.0fmV filtered=%.0fmV",
                 status,
                 snapshot.score,
                 snapshot.raw_mv,
                 snapshot.filtered_mv);
    } else {
        ESP_LOGE(TAG, "POST failed: %s", esp_err_to_name(err));
    }

    esp_http_client_cleanup(client);
}

static void sensor_task(void *pvParameters)
{
    float filtered_mv = 0.0f;

    while (1) {
        float raw_mv = adc_read_mv();
        int64_t now_value = now_ms();
        if (raw_mv >= 3200.0f && (now_value - s_last_adc_high_warn_ms) >= 5000) {
            ESP_LOGW(TAG, "ADC input is near 3.3V limit (raw=%.0fmV). Check AO wiring/divider for 5V sensor power.", raw_mv);
            s_last_adc_high_warn_ms = now_value;
        }

        if (filtered_mv <= 0.0f) {
            filtered_mv = raw_mv;
        } else {
            filtered_mv = filtered_mv * 0.75f + raw_mv * 0.25f;
        }

        float score = score_from_mv(filtered_mv);
        update_sensor_state(raw_mv, filtered_mv, score);

        ESP_LOGI(TAG, "sensor raw=%.0fmV filtered=%.0fmV score=%.1f", raw_mv, filtered_mv, score);
        vTaskDelay(pdMS_TO_TICKS(CONFIG_SENSOR_SAMPLE_PERIOD_MS));
    }
}

static void upload_task(void *pvParameters)
{
    // Wait for WiFi connection before starting uploads
    EventBits_t bits = xEventGroupWaitBits(
        s_wifi_event_group,
        WIFI_CONNECTED_BIT,
        pdFALSE,
        pdFALSE,
        portMAX_DELAY);
    
    if (bits & WIFI_CONNECTED_BIT) {
        // Upload immediately upon WiFi connection to sync remote settings like alarm_sound_enabled
        ESP_LOGI(TAG, "uploading sensor data to sync remote settings...");
        post_sensor_data_once();
    }

    while (1) {
        post_sensor_data_once();
        vTaskDelay(pdMS_TO_TICKS(CONFIG_SENSOR_POST_INTERVAL_SEC * 1000));
    }
}

static void alarm_task(void *pvParameters)
{
    int64_t last_warning_beep_ms = 0;
    int64_t last_alarm_beep_ms = 0;

    while (1) {
        if (!s_alarm_sound_enabled) {
            vTaskDelay(pdMS_TO_TICKS(150));
            continue;
        }

        sensor_state_t snapshot = copy_sensor_state();
        int64_t now_value = now_ms();

        if (snapshot.alarm) {
            if (now_value - last_alarm_beep_ms >= 1400) {
                audio_play_tone(CONFIG_ALARM_TONE_ALARM_HZ, CONFIG_ALARM_ALARM_BEEP_MS);
                last_alarm_beep_ms = now_value;
            }
        } else if (snapshot.warning) {
            if (now_value - last_warning_beep_ms >= 2200) {
                audio_play_tone(CONFIG_ALARM_TONE_WARNING_HZ, CONFIG_ALARM_WARNING_BEEP_MS);
                last_warning_beep_ms = now_value;
            }
        }

        vTaskDelay(pdMS_TO_TICKS(150));
    }
}

void app_main(void)
{
    esp_err_t ret = nvs_flash_init();
    if (ret == ESP_ERR_NVS_NO_FREE_PAGES || ret == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        ret = nvs_flash_init();
    }
    ESP_ERROR_CHECK(ret);

    ESP_ERROR_CHECK(adc_init_sensor());
    ESP_LOGI(TAG,
             "sensor map config: clean=%dmV dense=%dmV score_max=%d warning=%d alarm=%d inverted=%s",
             CONFIG_SENSOR_CLEAN_AIR_MV,
             CONFIG_SENSOR_DENSE_AIR_MV,
             CONFIG_SENSOR_SCORE_MAX,
             CONFIG_SENSOR_WARNING_THRESHOLD,
             CONFIG_SENSOR_ALARM_THRESHOLD,
             CONFIG_SENSOR_OUTPUT_INVERTED ? "yes" : "no");
    ESP_LOGI(TAG, "alarm sound default: %s", CONFIG_ALARM_SOUND_ENABLED ? "on" : "off");
    
    // I2S 初始化失败时不崩溃，允许仅使用空气传感器进行测试
    if (audio_init_i2s() != ESP_OK) {
        ESP_LOGW(TAG, "I2S init failed, audio features will be disabled");
    }

    // 提前启动传感器任务，确保在 Wi-Fi 报错前能看到数据
    xTaskCreate(sensor_task, "sensor_task", 4096, NULL, 5, NULL);
    xTaskCreate(alarm_task, "alarm_task", 4096, NULL, 3, NULL);

    if (!wifi_init_sta()) {
        ESP_LOGW(TAG, "WiFi init failed, continuing without network");
    } else {
        xTaskCreate(upload_task, "upload_task", 6144, NULL, 4, NULL);
    }
}
