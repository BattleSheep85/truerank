// Unit tests for worker/lib/product-link.js: universal product identity and
// retail SEO URL slug distillation (CP-720).
import {
  parseProductInput,
  productNameKey,
  isNameKey,
  distillProductName,
  trimProductType,
  MODEL_VARIANT_WORDS,
} from '../../worker/lib/product-link.js';
import { productKeys } from '../../worker/engine/verify-resolve.js';

export function runProductLinkUnitTests() {
  const report = { passed: 0, failed: 0, failures: [] };
  const eq = (name, a, e) => {
    const A = JSON.stringify(a);
    const E = JSON.stringify(e);
    if (A === E) report.passed++;
    else {
      report.failed++;
      report.failures.push(`${name}: expected ${E}, got ${A}`);
    }
  };
  const ok = (name, cond) => {
    if (cond) report.passed++;
    else {
      report.failed++;
      report.failures.push(name);
    }
  };

  // ── MODEL_VARIANT_WORDS allowlist ──────────────────────────────────────────
  const requiredVariants = [
    'ultra', 'pro', 'plus', 'max', 'mini', 'lite', 'se', 'fe', 'ti', 'xt',
    'super', 'oled', 'anc', 'nc', 'combo', 'duo', 'xl', 'xs', 'air', 'slim',
    'wood', 'flux', 'curve', 'mesh', 'rgb', 'argb',
  ];
  for (const token of requiredVariants) {
    ok(`MODEL_VARIANT_WORDS includes "${token}"`, MODEL_VARIANT_WORDS.has(token));
  }
  const nonVariants = ['dual', 'chamber', 'compatible', 'full', 'tower', 'black', 'white', 'case', 'tire', 'all', 'season', 'pack', 'inch'];
  for (const token of nonVariants) {
    ok(`MODEL_VARIANT_WORDS excludes descriptor "${token}"`, !MODEL_VARIANT_WORDS.has(token));
  }

  // ── Noisy retail URL slug distillation (6-to-10-word SEO slugs) ────────────
  const slugCases = [
    // Antec C8 vs Antec C8 Wood
    [
      'Amazon Antec C8 noisy 7-word SEO slug distills to "Antec C8"',
      'https://www.amazon.com/Antec-C8-Dual-Chamber-Compatible-Full-Tower/dp/B0C9X12345',
      {
        kind: 'url',
        name: 'Antec C8',
        url: 'https://www.amazon.com/dp/B0C9X12345',
        key: 'verify:asin:B0C9X12345|name:antec c8',
      },
    ],
    [
      'Amazon Antec C8 Wood noisy 8-word SEO slug keeps variant "Wood"',
      'https://www.amazon.com/Antec-C8-Wood-Dual-Chamber-Full-Tower-Case/dp/B0D1X67890',
      {
        kind: 'url',
        name: 'Antec C8 Wood',
        url: 'https://www.amazon.com/dp/B0D1X67890',
        key: 'verify:asin:B0D1X67890|name:antec c8 wood',
      },
    ],
    // Samsung Galaxy S25 vs Samsung Galaxy S25 Ultra
    [
      'Amazon Samsung Galaxy S25 noisy slug distills to "Samsung Galaxy S25"',
      'https://www.amazon.com/Samsung-Galaxy-S25-Cell-Phone-256GB-AI-Smartphone-Unlocked/dp/B0DS25BASE',
      {
        kind: 'url',
        name: 'Samsung Galaxy S25',
        url: 'https://www.amazon.com/dp/B0DS25BASE',
        key: 'verify:asin:B0DS25BASE|name:galaxy s25 samsung',
      },
    ],
    [
      'Amazon Samsung Galaxy S25 Ultra noisy slug keeps variant "Ultra"',
      'https://www.amazon.com/Samsung-Galaxy-S25-Ultra-Cell-Phone-256GB-Unlocked-Black/dp/B0DS25ULTR',
      {
        kind: 'url',
        name: 'Samsung Galaxy S25 Ultra',
        url: 'https://www.amazon.com/dp/B0DS25ULTR',
        key: 'verify:asin:B0DS25ULTR|name:galaxy s25 samsung ultra',
      },
    ],
    // Apple AirPods Pro 2 vs Apple AirPods 2
    [
      'Amazon Apple AirPods Pro 2 noisy slug distills to "Apple AirPods Pro 2"',
      'https://www.amazon.com/Apple-AirPods-Pro-2-Wireless-Earbuds-Active-Noise-Cancellation/dp/B0D1XD1ZV3',
      {
        kind: 'url',
        name: 'Apple AirPods Pro 2',
        url: 'https://www.amazon.com/dp/B0D1XD1ZV3',
        key: 'verify:asin:B0D1XD1ZV3|name:2 airpods apple pro',
      },
    ],
    [
      'Amazon Apple AirPods 2 noisy slug distills to "Apple AirPods 2"',
      'https://www.amazon.com/Apple-AirPods-2-Wireless-Earbuds-with-Charging-Case/dp/B07PXGQC1Q',
      {
        kind: 'url',
        name: 'Apple AirPods 2',
        url: 'https://www.amazon.com/dp/B07PXGQC1Q',
        key: 'verify:asin:B07PXGQC1Q|name:2 airpods apple',
      },
    ],
    // Sony WH-1000XM6 vs WF-1000XM6
    [
      'Amazon Sony WH-1000XM6 8-word slug distills to "Sony WH 1000XM6"',
      'https://www.amazon.com/Sony-WH-1000XM6-Wireless-Noise-Cancelling-Headphones-Black/dp/B0F3PT1VBL',
      {
        kind: 'url',
        name: 'Sony WH 1000XM6',
        url: 'https://www.amazon.com/dp/B0F3PT1VBL',
        key: 'verify:asin:B0F3PT1VBL|name:1000xm6 sony wh',
      },
    ],
    [
      'Amazon Sony WF-1000XM6 8-word slug distills to "Sony WF 1000XM6"',
      'https://www.amazon.com/Sony-WF-1000XM6-Truly-Wireless-Noise-Cancelling-Earbuds/dp/B0F3PT2EAR',
      {
        kind: 'url',
        name: 'Sony WF 1000XM6',
        url: 'https://www.amazon.com/dp/B0F3PT2EAR',
        key: 'verify:asin:B0F3PT2EAR|name:1000xm6 sony wf',
      },
    ],
    // Non-electronics: tires, kitchen appliances, tools, footwear
    [
      'Tire: Hankook Kinergy ST H735 noisy 10-word slug distills to "Hankook Kinergy ST H735"',
      'https://www.amazon.com/Hankook-Kinergy-ST-H735-All-Season-Radial-Tire-205-55R16/dp/B079KNNZ12',
      {
        kind: 'url',
        name: 'Hankook Kinergy ST H735',
        url: 'https://www.amazon.com/dp/B079KNNZ12',
        key: 'verify:asin:B079KNNZ12|name:h735 hankook kinergy st',
      },
    ],
    [
      'Kitchen appliance: Instant Pot Duo 7-in-1 noisy slug distills to "Instant Pot Duo"',
      'https://www.amazon.com/Instant-Pot-Duo-7-in-1-Electric-Pressure-Cooker-6-Quart/dp/B00FLYWNYQ',
      {
        kind: 'url',
        name: 'Instant Pot Duo',
        url: 'https://www.amazon.com/dp/B00FLYWNYQ',
        key: 'verify:asin:B00FLYWNYQ|name:duo instant pot',
      },
    ],
    [
      'Kitchen appliance: Vitamix 5200 noisy slug distills to "Vitamix 5200"',
      'https://www.amazon.com/Vitamix-5200-Blender-Professional-Grade-64-oz-Container/dp/B008H4SLV6',
      {
        kind: 'url',
        name: 'Vitamix 5200',
        url: 'https://www.amazon.com/dp/B008H4SLV6',
        key: 'verify:asin:B008H4SLV6|name:5200 vitamix',
      },
    ],
    [
      'Tools: DEWALT 20V MAX drill noisy slug keeps trailing model code DCD771C2',
      'https://www.amazon.com/DEWALT-20V-MAX-Cordless-Drill-Driver-Kit-DCD771C2/dp/B00ET5VMTU',
      {
        kind: 'url',
        name: 'DEWALT 20V MAX DCD771C2',
        url: 'https://www.amazon.com/dp/B00ET5VMTU',
        key: 'verify:asin:B00ET5VMTU|name:20v dcd771c2 dewalt max',
      },
    ],
    [
      'Footwear: Brooks Ghost 16 noisy slug distills to "Brooks Ghost 16"',
      'https://www.amazon.com/Brooks-Ghost-16-Mens-Neutral-Running-Shoes-Black/dp/B0C8GHOST6',
      {
        kind: 'url',
        name: 'Brooks Ghost 16',
        url: 'https://www.amazon.com/dp/B0C8GHOST6',
        key: 'verify:asin:B0C8GHOST6|name:16 brooks ghost',
      },
    ],
    [
      'Non-Amazon retailer (Walmart) noisy tire slug distills cleanly and keeps deterministic url key',
      'https://www.walmart.com/ip/Hankook-Kinergy-ST-H735-All-Season-Tire-205-55R16/987654321?athbdg=L1600',
      {
        kind: 'url',
        name: 'Hankook Kinergy ST H735',
        url: 'https://www.walmart.com/ip/Hankook-Kinergy-ST-H735-All-Season-Tire-205-55R16/987654321',
        key: 'verify:url:walmart.com/ip/Hankook-Kinergy-ST-H735-All-Season-Tire-205-55R16/987654321|name:h735 hankook kinergy st',
      },
    ],
  ];

  for (const [label, input, expected] of slugCases) {
    const out = parseProductInput(input);
    for (const [field, value] of Object.entries(expected)) {
      eq(`${label}: ${field}`, out ? out[field] : out, value);
    }
  }

  // ── distillProductName direct calls ────────────────────────────────────────
  eq('distillProductName: short 2-word name stays unchanged', distillProductName('Antec C8'), 'Antec C8');
  eq('distillProductName: short 3-word variant name stays unchanged', distillProductName('Antec C8 Wood'), 'Antec C8 Wood');
  eq('distillProductName: 7-word Antec C8 slug string distills to "Antec C8"', distillProductName('Antec C8 Dual Chamber Compatible Full Tower'), 'Antec C8');
  eq('distillProductName: 8-word Antec C8 Wood slug string distills to "Antec C8 Wood"', distillProductName('Antec C8 Wood Dual Chamber Compatible Full Tower'), 'Antec C8 Wood');
  eq('distillProductName: 8-word Hankook tire string distills to "Hankook Kinergy ST H735"', distillProductName('Hankook Kinergy ST H735 All Season Radial Tire'), 'Hankook Kinergy ST H735');
  eq('distillProductName: empty input returns empty string', distillProductName(''), '');

  // ── Deterministic reuse keys ───────────────────────────────────────────────
  ok(
    'Antec C8 and Antec C8 Wood produce distinct name keys',
    productNameKey('Antec C8') !== productNameKey('Antec C8 Wood'),
  );
  ok(
    'Samsung Galaxy S25 and Samsung Galaxy S25 Ultra produce distinct name keys',
    productNameKey('Samsung Galaxy S25') !== productNameKey('Samsung Galaxy S25 Ultra'),
  );
  ok(
    'Apple AirPods 2 and Apple AirPods Pro 2 produce distinct name keys',
    productNameKey('Apple AirPods 2') !== productNameKey('Apple AirPods Pro 2'),
  );
  ok(
    'Sony WH-1000XM6 and Sony WF-1000XM6 produce distinct name keys',
    productNameKey('Sony WH-1000XM6') !== productNameKey('Sony WF-1000XM6'),
  );
  eq('isNameKey identifies verify:name: keys', isNameKey(productNameKey('Antec C8')), true);


  // ── CP-777: trailing product-type words (repeat-run spread) ────────────────
  // "X" and "X case" read different pages and checked different claims.
  const typed = [
    ['Fractal Design North case', 'Fractal Design North'],
    ['Antec C8 PC case', 'Antec C8'],
    ['Google Pixel 9 Pro phone', 'Google Pixel 9 Pro'],
    ['Samsung Galaxy S25 Ultra phone', 'Samsung Galaxy S25 Ultra'],
    ['Michelin CrossClimate 2 tire', 'Michelin CrossClimate 2'],
    ['Michelin Defender 2 tires', 'Michelin Defender 2'],
    ['Ninja Creami ice cream maker', 'Ninja Creami'],
    ['Dyson V15 Detect vacuum', 'Dyson V15 Detect'],
    ['DeWalt DCD791 20V drill', 'DeWalt DCD791'],
    ['DeWalt DCD791 drill', 'DeWalt DCD791'],
    ['Milwaukee M18 Fuel 2953 impact driver', 'Milwaukee M18 Fuel 2953'],
    ['Apple iPhone 16 128GB', 'Apple iPhone 16'],
    ['Fractal Design North Case', 'Fractal Design North'],
  ];
  for (const [input, expected] of typed) {
    eq(`CP-777 trimProductType: "${input}"`, trimProductType(input), expected);
  }
  eq('CP-777 trimProductType: a name without a type word stays', trimProductType('Fractal Design North'), 'Fractal Design North');
  eq('CP-777 trimProductType: keeps two words (OtterBox case)', trimProductType('OtterBox case'), 'OtterBox case');
  eq('CP-777 trimProductType: keeps two words (Pixel phone)', trimProductType('Pixel phone'), 'Pixel phone');
  eq('CP-777 trimProductType: a type word inside the name stays', trimProductType('Bose QuietComfort Earbuds'), 'Bose QuietComfort Earbuds');
  eq('CP-777 trimProductType: a variant word is never trimmed', trimProductType('Antec C8 Wood'), 'Antec C8 Wood');
  eq('CP-777 trimProductType: spec words alone are not trimmed to one word', trimProductType('Anker 20V'), 'Anker 20V');
  // A one-letter "unit" at the end is usually the model: 3S, 5s, 5c, 4a 5G.
  for (const name of ['Logitech MX Master 3S', 'Apple iPhone 5s', 'Apple iPhone 5c', 'Google Pixel 4a 5G', 'DJI Mini 4K']) {
    eq(`CP-777 trimProductType: a one-letter model suffix stays ("${name}")`, trimProductType(name), name);
  }
  eq('CP-777 trimProductType: a one-letter model suffix stays before a type word', trimProductType('Logitech MX Master 3S mouse'), 'Logitech MX Master 3S mouse');
  // An accessory case keeps "case": it is not the device.
  for (const name of ['Apple iPhone 16 case', 'Nintendo Switch 2 case', 'Samsung Galaxy S25 phone case', 'Apple AirPods Pro 2 case', 'Apple iPad Air case']) {
    eq(`CP-777 trimProductType: an accessory case stays ("${name}")`, trimProductType(name), name);
  }
  // "Phone" in a product line name stays; only a phone with a model number loses it.
  eq('CP-777 trimProductType: "Asus ROG Phone" stays', trimProductType('Asus ROG Phone'), 'Asus ROG Phone');
  eq('CP-777 trimProductType: "Nothing CMF Phone" stays', trimProductType('Nothing CMF Phone'), 'Nothing CMF Phone');
  eq('CP-777 trimProductType: a watt rating still goes', trimProductType('Anker Nano 65W'), 'Anker Nano');
  eq('CP-777 trimProductType: empty input gives ""', trimProductType('  '), '');
  eq('CP-777 trimProductType: non-string gives ""', trimProductType(null), '');
  eq('CP-777 distillProductName: short typed name drops the type word', distillProductName('Fractal Design North case'), 'Fractal Design North');
  eq('CP-777 distillProductName: same search name for both pair members', distillProductName('Ninja Creami ice cream maker'), distillProductName('Ninja Creami'));
  eq('CP-777 productKeys: same key with or without the type words', productKeys(trimProductType('Ninja Creami ice cream maker')), productKeys('Ninja Creami'));

  // ── CP-781: "dual" and "compact" name a product variant ───────────────────
  eq('CP-781 distillProductName: "Compact" stays in the Torrent Compact name', distillProductName('Fractal Design Torrent Compact Black Tempered Glass'), 'Fractal Design Torrent Compact');
  eq('CP-781 distillProductName: plain Torrent has no "Compact"', distillProductName('Fractal Design Torrent Black Tempered Glass ATX'), 'Fractal Design Torrent');
  ok('CP-781 parseProductInput: Torrent and Torrent Compact get different keys',
    parseProductInput('https://www.amazon.com/Fractal-Design-Torrent-Compact-Black-Tempered-Glass/dp/B0A1B2C3D4').key
      !== parseProductInput('https://www.amazon.com/Fractal-Design-Torrent-Black-Tempered-Glass-ATX/dp/B0A1B2C3D4').key);
  eq('CP-781 distillProductName: "Dual" after the model number stays', distillProductName('Anker 737 Dual Charger Portable Fast Charging'), 'Anker 737 Dual');
  eq('CP-781 distillProductName: "Dual Chamber" is still a description', distillProductName('Antec C8 Dual Chamber Compatible Full Tower'), 'Antec C8');
  eq('CP-781 distillProductName: "Compact Drill" is still a description', distillProductName('DEWALT 20V MAX Compact Drill Driver Kit DCD771C2'), 'DEWALT 20V MAX DCD771C2');

  // ── CP-783: a hyphenated size is a spec, not a model number ───────────────
  eq('CP-783 distillProductName: "65-Inch" does not end the name', distillProductName('SAMSUNG 65-Inch Class OLED S90D Series 4K Smart TV'), 'SAMSUNG 65-Inch Class OLED S90D');
  eq('CP-783 distillProductName: "2-Pack" does not end the name', distillProductName('Apple AirTag 2-Pack Item Finder Tracker Bluetooth'), 'Apple AirTag');
  eq('CP-783 distillProductName: a hyphenated model number still ends the name', distillProductName('Sony WH-1000XM6 Wireless Noise Canceling Headphones Black'), 'Sony WH-1000XM6');
  eq('CP-783 trimProductType: a hyphenated size trims like "65Inch"', trimProductType('Samsung S90D 65-Inch'), trimProductType('Samsung S90D 65Inch'));

  return report;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = runProductLinkUnitTests();
  console.log(`product-link: ${r.passed}/${r.passed + r.failed} passed`);
  if (r.failed > 0) {
    for (const f of r.failures) console.error('  FAIL', f);
    process.exit(1);
  }
}
