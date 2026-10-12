import re


ID_PATTERN = re.compile(r"[1-9][0-9]{0,127}")


def is_valid_id(value):
    return isinstance(value, str) and ID_PATTERN.fullmatch(value) is not None
