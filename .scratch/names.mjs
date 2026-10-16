import { distillProductName } from '../worker/lib/product-link.js';
import { productKeys } from '../worker/engine/verify-resolve.js';
for (const q of ['Fractal Design North','Fractal Design North case','Google Pixel 9 Pro phone','Samsung Galaxy S25 Ultra phone','Michelin CrossClimate 2 tire','Ninja Creami ice cream maker','Dyson V15 Detect vacuum','DeWalt DCD791 20V drill','DeWalt DCD791 drill'])
  console.log(q, '=>', JSON.stringify(distillProductName(q)), JSON.stringify(productKeys(q)));
