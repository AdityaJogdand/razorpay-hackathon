"""
Decline code taxonomy mapping.

Sources:
1. Razorpay API Documentation — https://razorpay.com/docs/payments/payments/error-codes/
2. NPCI UPI Technical Specification — https://www.npci.org.in/what-we-do/upi/product-statistics
3. ISO 8583 / Card Network Decline Codes (Visa, Mastercard, RuPay)

FROZEN: This mapping was built from published sources before any policy code.
Do not modify after the data generator is frozen (per PRD R3).
"""

from backend.models.enums import FailureClass

# --- Razorpay error reasons -> failure class ---
RAZORPAY_REASON_MAP: dict[str, FailureClass] = {
    # HARD — instrument is dead
    "payment_failed_because_card_expired": FailureClass.HARD,
    "payment_failed_because_card_invalid": FailureClass.HARD,
    "payment_failed_because_card_lost_or_stolen": FailureClass.HARD,
    "payment_failed_because_card_pickup": FailureClass.HARD,
    "payment_failed_because_account_closed": FailureClass.HARD,
    "payment_failed_because_card_restricted": FailureClass.HARD,
    "payment_failed_because_card_not_enabled_for_online": FailureClass.HARD,
    "payment_failed_because_invalid_vpa": FailureClass.HARD,
    "payment_failed_because_international_transaction_not_allowed": FailureClass.HARD,

    # SOFT — transient, may succeed on retry
    "payment_failed_because_insufficient_balance": FailureClass.SOFT,
    "payment_failed_because_issuer_unavailable": FailureClass.SOFT,
    "payment_failed_because_gateway_timeout": FailureClass.SOFT,
    "payment_failed_because_gateway_unavailable": FailureClass.SOFT,
    "payment_failed_because_exceeds_withdrawal_limit": FailureClass.SOFT,
    "payment_failed_because_incorrect_pin": FailureClass.SOFT,
    "payment_failed_because_incorrect_otp": FailureClass.SOFT,
    "payment_failed_because_otp_expired": FailureClass.SOFT,
    "payment_failed_because_3ds_authentication_failed": FailureClass.SOFT,
    "payment_failed_because_cancelled_by_customer": FailureClass.SOFT,
    "payment_failed_because_psp_not_available": FailureClass.SOFT,
    "payment_failed_because_server_error": FailureClass.SOFT,
    "payment_failed_because_duplicate_request": FailureClass.SOFT,

    # MANDATE — UPI/e-mandate lifecycle
    "payment_failed_because_mandate_not_found": FailureClass.MANDATE,
    "payment_failed_because_mandate_revoked": FailureClass.MANDATE,
    "payment_failed_because_mandate_paused": FailureClass.MANDATE,
    "payment_failed_because_mandate_expired": FailureClass.MANDATE,
    "payment_failed_because_debit_not_allowed_on_mandate": FailureClass.MANDATE,

    # UNKNOWN — ambiguous, needs human review or LLM classification
    "payment_failed_because_risk_check_failed": FailureClass.UNKNOWN,
    "payment_failed_because_do_not_honor": FailureClass.UNKNOWN,
    "payment_failed_because_declined_by_issuer": FailureClass.UNKNOWN,
}

# --- NPCI UPI response codes -> failure class ---
NPCI_UPI_CODE_MAP: dict[str, FailureClass] = {
    # SOFT — transient
    "U01": FailureClass.SOFT,   # Duplicate request
    "U02": FailureClass.SOFT,   # Insufficient funds
    "U04": FailureClass.SOFT,   # Beneficiary bank not available
    "U05": FailureClass.SOFT,   # Remitter bank not available
    "U06": FailureClass.SOFT,   # Transaction declined by payer
    "U08": FailureClass.SOFT,   # Invalid/Incorrect MPIN
    "U09": FailureClass.SOFT,   # Collect request expired
    "U10": FailureClass.SOFT,   # Remitter bank system error
    "U14": FailureClass.SOFT,   # Encryption error
    "U15": FailureClass.SOFT,   # Duplicate beneficiary registration
    "U16": FailureClass.SOFT,   # Amount limit exceeded
    "U19": FailureClass.SOFT,   # Timeout
    "U20": FailureClass.SOFT,   # Beneficiary connectivity issue
    "U21": FailureClass.SOFT,   # Beneficiary format/security error
    "U22": FailureClass.SOFT,   # Remitter PSP not available
    "U25": FailureClass.SOFT,   # NPCI system error
    "U27": FailureClass.SOFT,   # Pending — no response from beneficiary

    "U48": FailureClass.SOFT,   # Timed out at beneficiary
    "U49": FailureClass.SOFT,   # Timed out at NPCI
    "U50": FailureClass.SOFT,   # Remitter CBS offline
    "U52": FailureClass.SOFT,   # Connection timeout — beneficiary bank
    "U55": FailureClass.SOFT,   # MPIN attempts exceeded
    "U70": FailureClass.SOFT,   # Beneficiary bank maintenance/cut-off
    "YE": FailureClass.SOFT,    # NPCI internal error
    "YG": FailureClass.SOFT,    # Remitting bank CBS timeout
    "ZE": FailureClass.SOFT,    # PSP error
    "ZM": FailureClass.SOFT,    # Invalid MPIN
    "ZR": FailureClass.SOFT,    # Invalid/Incorrect OTP
    "ZX": FailureClass.SOFT,    # Format error
    "Z6": FailureClass.SOFT,    # Remitter bank unable to process
    "Z7": FailureClass.SOFT,    # Insufficient funds
    "Z8": FailureClass.SOFT,    # Beneficiary limit exceeded
    "Z9": FailureClass.SOFT,    # Pending — no response

    # HARD — permanent
    "U03": FailureClass.HARD,   # Transaction not permitted to account
    "U07": FailureClass.HARD,   # Beneficiary registration rejected
    "U11": FailureClass.HARD,   # Invalid beneficiary account
    "U12": FailureClass.HARD,   # Transaction not permitted to payee
    "U13": FailureClass.HARD,   # Invalid MMID or mobile number
    "U17": FailureClass.HARD,   # PSP not registered
    "U23": FailureClass.HARD,   # Payer VPA not valid
    "U24": FailureClass.HARD,   # Payee VPA not valid
    "U28": FailureClass.HARD,   # Payer account blocked/frozen
    "U29": FailureClass.HARD,   # Address resolution failed
    "U31": FailureClass.HARD,   # Payer account does not exist
    "U32": FailureClass.HARD,   # Regulatory/compliance restriction
    "U33": FailureClass.HARD,   # Invalid device fingerprint
    "U34": FailureClass.HARD,   # Credential/MPIN not set
    "U35": FailureClass.HARD,   # Payee account dormant
    "U36": FailureClass.HARD,   # KYC issue
    "U53": FailureClass.HARD,   # NRI account
    "U56": FailureClass.HARD,   # Remitter marked as fraud
    "U57": FailureClass.HARD,   # Payee not onboarded
    "U66": FailureClass.HARD,   # Device fingerprint mismatch
    "U68": FailureClass.HARD,   # MPIN locked
    "U69": FailureClass.HARD,   # Mobile not registered with bank
    "ZH": FailureClass.HARD,    # Invalid VPA
    "RB": FailureClass.HARD,    # Registration declined by beneficiary bank

    # MANDATE — UPI mandate lifecycle
    "U37": FailureClass.MANDATE,  # Mandate revoked
    "U38": FailureClass.MANDATE,  # Mandate paused
    "U39": FailureClass.MANDATE,  # Mandate expired
    "U40": FailureClass.MANDATE,  # Mandate not found
    "U41": FailureClass.MANDATE,  # Mandate debit limit breached
    "U42": FailureClass.MANDATE,  # Mandate execution date mismatch
    "U43": FailureClass.MANDATE,  # Mandate creation rejected
    "U44": FailureClass.MANDATE,  # Mandate modification rejected
    "U45": FailureClass.MANDATE,  # Mandate amount exceeded
    "U46": FailureClass.MANDATE,  # Mandate rejected by payer PSP
    "U47": FailureClass.MANDATE,  # Pre-debit notification not sent
    "RM": FailureClass.MANDATE,   # Mandate revoked by payer
    "AM": FailureClass.MANDATE,   # Mandate amount limit exceeded

    # UNKNOWN — ambiguous
    "U18": FailureClass.UNKNOWN,  # Do Not Honor
    "U26": FailureClass.UNKNOWN,  # Declined by payee PSP
    "U30": FailureClass.UNKNOWN,  # Debit declined — account issue (ambiguous)
    "U51": FailureClass.UNKNOWN,  # Rejected by payee bank
    "U54": FailureClass.UNKNOWN,  # Risk threshold breached
    "ZA": FailureClass.UNKNOWN,   # Declined by payer — no reason
    "Z5": FailureClass.UNKNOWN,   # Declined by beneficiary bank
}

# --- ISO 8583 card decline codes -> failure class ---
# These are the two-digit response codes from Visa/Mastercard/RuPay
CARD_DECLINE_CODE_MAP: dict[str, FailureClass] = {
    # HARD — permanent
    "03": FailureClass.HARD,      # Invalid merchant
    "04": FailureClass.HARD,      # Capture card / pickup
    "07": FailureClass.HARD,      # Pickup — fraud
    "14": FailureClass.HARD,      # Invalid card number
    "15": FailureClass.HARD,      # No such issuer
    "33": FailureClass.HARD,      # Expired card — pickup
    "34": FailureClass.HARD,      # Suspected fraud
    "36": FailureClass.HARD,      # Restricted card
    "41": FailureClass.HARD,      # Lost card — pickup
    "43": FailureClass.HARD,      # Stolen card — pickup
    "46": FailureClass.HARD,      # Closed account
    "52": FailureClass.HARD,      # No checking account
    "53": FailureClass.HARD,      # No savings account
    "54": FailureClass.HARD,      # Expired card
    "57": FailureClass.HARD,      # Transaction not permitted to cardholder
    "58": FailureClass.HARD,      # Transaction not permitted to terminal
    "59": FailureClass.HARD,      # Suspected fraud
    "62": FailureClass.HARD,      # Restricted card (country exclusion)
    "63": FailureClass.HARD,      # Security violation
    "76": FailureClass.HARD,      # Invalid/non-existent account (Visa)
    "78": FailureClass.HARD,      # New card not yet activated
    "82": FailureClass.HARD,      # Negative CVV results (Visa)
    "93": FailureClass.HARD,      # Violation of law

    # SOFT — transient
    "06": FailureClass.SOFT,      # Error
    "13": FailureClass.SOFT,      # Invalid amount
    "19": FailureClass.SOFT,      # Re-enter transaction
    "30": FailureClass.SOFT,      # Format error
    "38": FailureClass.SOFT,      # PIN tries exceeded
    "51": FailureClass.SOFT,      # Insufficient funds
    "55": FailureClass.SOFT,      # Incorrect PIN
    "61": FailureClass.SOFT,      # Exceeds withdrawal limit
    "65": FailureClass.SOFT,      # Exceeds frequency limit
    "68": FailureClass.SOFT,      # Response received too late (timeout)
    "75": FailureClass.SOFT,      # PIN tries exceeded
    "91": FailureClass.SOFT,      # Issuer or switch inoperative
    "92": FailureClass.SOFT,      # Unable to route transaction
    "94": FailureClass.SOFT,      # Duplicate transmission
    "96": FailureClass.SOFT,      # System malfunction
    "N7": FailureClass.SOFT,      # CVV2/CVC2 mismatch (Visa)

    # MANDATE — recurring card
    "R0": FailureClass.MANDATE,   # Stop payment order (recurring)
    "R1": FailureClass.MANDATE,   # Revocation of authorization (recurring)
    "R3": FailureClass.MANDATE,   # Revocation of all authorizations (recurring)

    # UNKNOWN — ambiguous
    "01": FailureClass.UNKNOWN,   # Refer to card issuer
    "02": FailureClass.UNKNOWN,   # Refer to card issuer (special)
    "05": FailureClass.UNKNOWN,   # Do Not Honor (ambiguous — most common)
    "12": FailureClass.UNKNOWN,   # Invalid transaction
}

# --- Unified lookup ---

# Normalized code -> (FailureClass, source)
# Priority: Razorpay reason > NPCI UPI > Card decline
_UNIFIED_MAP: dict[str, tuple[FailureClass, str]] = {}

for code, cls in RAZORPAY_REASON_MAP.items():
    _UNIFIED_MAP[code] = (cls, "razorpay")

for code, cls in NPCI_UPI_CODE_MAP.items():
    _UNIFIED_MAP[code] = (cls, "npci_upi")

for code, cls in CARD_DECLINE_CODE_MAP.items():
    _UNIFIED_MAP[code] = (cls, "iso8583")


def classify_by_rules(normalized_code: str) -> tuple[FailureClass | None, str | None]:
    """
    Look up a normalized decline code in the taxonomy.
    Returns (FailureClass, source) or (None, None) if unmapped.
    """
    result = _UNIFIED_MAP.get(normalized_code)
    if result:
        return result
    return None, None


# All codes that map to each class, for synthetic data generation
HARD_CODES = [c for c, (cls, _) in _UNIFIED_MAP.items() if cls == FailureClass.HARD]
SOFT_CODES = [c for c, (cls, _) in _UNIFIED_MAP.items() if cls == FailureClass.SOFT]
MANDATE_CODES = [c for c, (cls, _) in _UNIFIED_MAP.items() if cls == FailureClass.MANDATE]
UNKNOWN_CODES = [c for c, (cls, _) in _UNIFIED_MAP.items() if cls == FailureClass.UNKNOWN]
