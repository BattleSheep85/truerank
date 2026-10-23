// What kind of page a research row renders as, from its category and classifier facets.
// Shared by the research page, the reviews browse cards and the orchestrator's ASIN gate,
// so "is this an Amazon page?" has one answer everywhere.

// Categories where "Buy on Amazon" is nonsensical — services, local professionals,
// regional food, real estate, etc. These get a "Visit site" / "Search online" CTA
// instead of the Amazon-search fallback so the page doesn't look idiotic.
const NON_PRODUCT_CATEGORY_HINTS = [
  'real estate', 'realtor', 'realty', 'broker',
  'service', 'services', 'professional', 'professionals',
  'agent', 'agents', 'contractor', 'contractors',
  'plumber', 'plumbing', 'electrician', 'hvac',
  'attorney', 'lawyer', 'legal', 'law firm',
  'insurance', 'accountant', 'cpa', 'tax',
  'therapist', 'therapy', 'counselor', 'counseling',
  'doctor', 'dentist', 'clinic', 'hospital',
  'restaurant', 'bakery', 'cafe', 'food',
  'local', 'regional',
  'consultant', 'consulting', 'agency',
];

export function isNonProductCategory(category) {
  if (!category) return false;
  const c = category.toLowerCase();
  return NON_PRODUCT_CATEGORY_HINTS.some((h) => c.includes(h));
}

/**
 * CP-803: a place to go or a thing to do (coffee shops, day hikes, national parks).
 * Never a buyable product, even one with a place or trip in it ("snow tires in Denver",
 * "best tent for Yosemite").
 */
export function isPlaceOrExperience(facets) {
  const f = facets || {};
  return (f.is_experience === true || f.needs_location === true) && f.is_buyable !== true;
}

/** Whether Amazon links make sense for this row. Legacy rows without facets default to yes. */
export function isAmazonViable(facets) {
  const f = facets || {};
  return f.sold_on_amazon !== false && f.is_service !== true && !isPlaceOrExperience(f);
}

/**
 * isService: services, local places and experiences ("Recommendations", Google hand-off).
 * webOnly: a product the classifier says Amazon doesn't sell (Google hand-off, no Amazon).
 */
export function pageKind(category, facets) {
  const f = facets || {};
  return {
    isService: isNonProductCategory(category) || f.is_service === true || isPlaceOrExperience(f),
    webOnly: f.sold_on_amazon === false,
  };
}
