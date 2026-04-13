idf_component_register(
    SRCS "main.c"
    INCLUDE_DIRS "."
    PRIV_REQUIRES esp_timer esp_http_client esp_netif esp_event esp_wifi nvs_flash esp_adc driver
)

