from backend.classifier.taxonomy import classify_by_rules, normalize_error_code


def test_normalize_common_raw_error_codes():
    assert normalize_error_code("INSUFFICIENT_FUNDS") == "payment_failed_because_insufficient_balance"
    assert normalize_error_code("CARD_EXPIRED") == "payment_failed_because_card_expired"
    assert normalize_error_code("MANDATE_EXPIRED") == "payment_failed_because_mandate_expired"


def test_classify_by_rules_accepts_common_raw_codes():
    assert classify_by_rules("INSUFFICIENT_FUNDS")[0].value == "SOFT"
    assert classify_by_rules("CARD_EXPIRED")[0].value == "HARD"
    assert classify_by_rules("MANDATE_EXPIRED")[0].value == "MANDATE"
