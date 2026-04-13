idf_component_register(SRCS "station_example_main.c"
                    INCLUDE_DIRS "."
                    PRIV_REQUIRES esp_timer esp_http_client esp_netif esp_event esp_wifi nvs_flash)
