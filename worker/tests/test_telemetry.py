from folio_worker import telemetry
from folio_worker.worker import dbos_config


def test_off_until_a_collector_is_named():
    assert telemetry.dbos_settings({}) == {}
    assert telemetry.dbos_settings({"OTEL_EXPORTER_OTLP_ENDPOINT": "http://otel:4318", "OTEL_SDK_DISABLED": "true"}) == {}


def test_sends_traces_and_logs_where_the_standard_settings_say():
    assert telemetry.dbos_settings({"OTEL_EXPORTER_OTLP_ENDPOINT": "http://otel:4318/"}) == {
        "enable_otlp": True,
        "otlp_traces_endpoints": ["http://otel:4318/v1/traces"],
        "otlp_logs_endpoints": ["http://otel:4318/v1/logs"],
    }
    # A traces endpoint of its own is used as it is, and logs then go nowhere unless named too.
    assert telemetry.dbos_settings({"OTEL_EXPORTER_OTLP_TRACES_ENDPOINT": "http://c/t"}) == {"enable_otlp": True, "otlp_traces_endpoints": ["http://c/t"]}


def test_dbos_gets_them_with_its_settings():
    config = dbos_config("folio", "postgres://x", {"OTEL_EXPORTER_OTLP_ENDPOINT": "http://otel:4318"})
    assert config["enable_otlp"] is True and config["name"] == "folio"
    assert "enable_otlp" not in dbos_config("folio", "postgres://x", {})
