// Apify SDK - toolkit for building Apify Actors (Read more at https://docs.apify.com/sdk/js/)
import { Actor } from 'apify';
import { CheerioCrawler, Dataset } from 'crawlee';

// Initialize Actor
await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
  startUrls = ['https://example-finance.com/loans'],
  maxRequestsPerCrawl = 200,
  followInternalOnly = true,
  redactPII = true,
} = input;

// Proxy configuration
const proxyConfiguration = await Actor.createProxyConfiguration();

const crawler = new CheerioCrawler({
  proxyConfiguration,
  maxRequestsPerCrawl,
  async requestHandler({ request, $, enqueueLinks, log }) {
    const url = request.loadedUrl ?? request.url;
    log.info('Processing', { url });

    // Enqueue likely product pages and listing pages
    await enqueueLinks({
      globs: ['**/product/**', '**/products/**', '**/loan/**', '**/loans/**', '**/bnpl/**', '**/pay-later/**'],
      transformRequestFunction: (r) => {
        if (followInternalOnly) {
          try {
            const startHost = new URL(request.userData.startHost || request.url).host;
            const candidateHost = new URL(r.url).host;
            if (candidateHost !== startHost) return null;
          } catch (e) {
            // ignore malformed URLs
          }
        }
        return r;
      },
    });

    try {
      // Heuristics to determine if this page contains product/pricing info
      const bodyText = $('body').text().toLowerCase();
      const looksLikeProduct =
        url.match(/product|loan|bnpl|pay-later|offer|plan/) ||
        bodyText.includes('apr') ||
        bodyText.includes('interest rate') ||
        bodyText.includes('monthly payment');

      if (!looksLikeProduct) {
        log.debug('Not a product-like page; skipping', { url });
        return;
      }

      // Provider and product
      const provider =
        $('meta[property="og:site_name"]').attr('content') ||
        $('meta[name="application-name"]').attr('content') ||
        $('header h1, .site-name').first().text().trim() ||
        new URL(url).hostname;

      const product_name =
        $('h1').first().text().trim() ||
        $('meta[property="og:title"]').attr('content') ||
        $('title').text().trim() ||
        '';

      // Product type guess
      let product_type = '';
      if (/bnpl|buy now|pay later|pay-later/i.test(bodyText)) product_type = 'BNPL';
      else if (/loan|personal loan|microloan|installment/i.test(bodyText)) product_type = 'Loan';
      else product_type = 'Credit Product';

      // APR / rate heuristics
      let apr = '';
      const aprMatch = bodyText.match(/(?:apr|interest rate|annual percentage rate)[^\d]{0,20}([0-9]{1,3}(?:\.[0-9]+)?%?)/i);
      if (aprMatch) apr = aprMatch[1];

      // Fees heuristics
      let fees = '';
      const feesEl = $('[class*="fee"], [id*="fee"], :contains("fee")').filter((i, el) => $(el).text().toLowerCase().includes('fee')).first();
      if (feesEl && feesEl.length) fees = feesEl.text().trim().slice(0, 400);

      // Term heuristics
      let term = '';
      const termMatch = bodyText.match(/\b(term|months|weeks)\b[^\d]{0,20}(\d{1,3}\s?(months?|years?))/i);
      if (termMatch) term = termMatch[2] || termMatch[1] || '';

      // Eligibility heuristics
      const eligibilityEl = $('*:contains("eligibility"), *:contains("requirements"), *:contains("who can apply")')
        .filter((i, el) => /eligibility|requirements|who can apply/i.test($(el).text()))
        .first();
      const eligibility = eligibilityEl.length ? eligibilityEl.text().trim().slice(0, 800) : '';

      // Sample monthly payment heuristic (if APR + term found)
      let sample_monthly_payment = '';
      if (apr && term) {
        // Naive numeric parse - try to extract numbers
        const aprNum = Number(apr.replace(/[^0-9.]/g, '')) || null;
        const termNumMatch = term.match(/(\d{1,4})/);
        const termNum = termNumMatch ? Number(termNumMatch[1]) : null;
        // Without principal we cannot compute real payment; leave blank or capture example snippets
        const paymentEl = bodyText.match(/(monthly payment|pay per month)[^\d\$]{0,20}(\$[0-9.,]+)/i);
        if (paymentEl) sample_monthly_payment = paymentEl[2];
      }

      // Redact PII if requested: remove emails, phone numbers from captured strings
      const redact = (s) => {
        if (!s) return s;
        let out = s;
        if (redactPII) {
          out = out.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[REDACTED_EMAIL]');
          out = out.replace(/(\+?\d[\d\-\s().]{7,}\d)/g, '[REDACTED_PHONE]');
          out = out.replace(/\b\d{3}[-.\s]?\d{2}[-.\s]?\d{4}\b/g, '[REDACTED_SSN]');
        }
        return out;
      };

      const record = {
        provider: redact(provider),
        product_name: redact(product_name),
        product_type,
        apr: redact(apr),
        fees: redact(fees),
        term: redact(term),
        eligibility: redact(eligibility),
        sample_monthly_payment: redact(sample_monthly_payment),
        source_url: url,
        extracted_at: new Date().toISOString(),
      };

      await Dataset.pushData(record);
      log.info('Saved product', { provider: record.provider, product_name: record.product_name, url });
    } catch (err) {
      log.warning('Extraction failed', { url, message: err.message });
    }
  },
});

await crawler.run(startUrls);

// Gracefully exit
await Actor.exit();
