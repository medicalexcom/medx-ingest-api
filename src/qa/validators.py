import json
import jsonschema
from jsonschema import validate
from pathlib import Path
from typing import Dict, List

SCHEMA_PATH = Path(__file__).resolve().parents[2] / "json_schemas" / "product.schema.json"

class QAError(Exception):
    pass

def schema_validate(product: Dict) -> List[str]:
    schema = json.loads(SCHEMA_PATH.read_text())
    try:
        validate(instance=product, schema=schema)
        return []
    except jsonschema.ValidationError as e:
        return [f"Schema: {e.message} at {'/'.join(map(str, e.path))}"]

def content_rules_validate(product: Dict, rules: Dict) -> List[str]:
    errors = []
    # Required disclaimer on medical/supplement categories
    if any("supplement" in c.lower() or "medical" in c.lower() for c in product.get("categories", [])):
        disclaimer = product.get("regulatory_disclaimer", "")
        if rules.get("required_disclaimer") and rules["required_disclaimer"] not in disclaimer:
            errors.append("Content: missing required regulatory disclaimer")

    # Banned phrases in descriptions
    desc = (product.get("description") or "") + " " + (product.get("short_description") or "")
    for phrase in rules.get("banned_phrases", []):
        if phrase.lower() in desc.lower():
            errors.append(f"Content: banned phrase detected → {phrase}")

    # SEO lengths
    if product.get("meta_title") and len(product["meta_title"]) > rules["seo"]["title_max"]:
        errors.append("SEO: meta_title exceeds 70 chars")
    if product.get("meta_description") and len(product["meta_description"]) > rules["seo"]["description_max"]:
        errors.append("SEO: meta_description exceeds 160 chars")

    # Images
    if len(product.get("images", [])) < rules["images"]["min_count"]:
        errors.append("Images: at least one product image is required")

    return errors

def bigcommerce_validate(product: Dict) -> List[str]:
    errors = []
    skus = set()
    # root SKU present
    if not product.get("sku"):
        errors.append("BC: root SKU missing")

    # variant checks
    for v in product.get("variants", []) or []:
        if v["sku"] in skus:
            errors.append(f"BC: duplicate variant SKU {v['sku']}")
        skus.add(v["sku"])
        if "option_values" not in v or not v["option_values"]:
            errors.append(f"BC: variant {v['sku']} missing option_values")

    return errors

def run_all(product: Dict, rules: Dict) -> List[str]:
    return schema_validate(product) + content_rules_validate(product, rules) + bigcommerce_validate(product)
