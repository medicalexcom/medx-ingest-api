from pydantic import BaseModel, HttpUrl, Field, validator
from typing import List, Optional

class OptionValue(BaseModel):
    option_name: str
    value: str

class Variant(BaseModel):
    sku: str
    price: float = Field(ge=0)
    option_values: List[OptionValue]
    image_url: Optional[HttpUrl] = None

class FAQItem(BaseModel):
    q: str
    a: str

class Product(BaseModel):
    name: str = Field(min_length=3, max_length=255)
    sku: str
    brand: str
    price: float = Field(ge=0)
    description: str = Field(min_length=30)
    short_description: Optional[str] = None
    images: List[HttpUrl]
    categories: List[str]
    specs_html: Optional[str] = None
    faq: Optional[List[FAQItem]] = None
    variants: Optional[List[Variant]] = None
    meta_title: Optional[str] = Field(default=None, max_length=70)
    meta_description: Optional[str] = Field(default=None, max_length=160)
    regulatory_disclaimer: Optional[str] = None

    @validator("categories")
    def non_empty_categories(cls, v):
        if not v:
            raise ValueError("At least one category is required")
        return v
