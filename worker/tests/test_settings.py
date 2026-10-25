from folio_worker.settings import from_env, key_id_for

STORAGE = {
    "DATABASE_URL": "postgres://app_folio:pw@postgres:5432/platform",
    "S3_ENDPOINT": "http://garage:3900",
    "S3_BUCKET": "folio",
    "S3_SECRET_ACCESS_KEY": "6c6f63616c2d6f6e6c792d666f6c696f2d6275636b65742d7365637265742d30",
}


def test_names_the_key_after_its_secret_as_the_platform_does():
    assert key_id_for(STORAGE["S3_SECRET_ACCESS_KEY"]) == "GK999cf764e1807dfcdb6310d6"
    assert from_env(STORAGE).bucket.access_key_id == "GK999cf764e1807dfcdb6310d6"


def test_takes_a_key_id_it_is_given():
    assert from_env({**STORAGE, "S3_ACCESS_KEY_ID": "GKgiven"}).bucket.access_key_id == "GKgiven"
