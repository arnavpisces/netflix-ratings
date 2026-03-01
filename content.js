const SUCCESS_CACHE_EXPIRY_DAYS = 30;
const SUCCESS_CACHE_EXPIRY_MS = SUCCESS_CACHE_EXPIRY_DAYS * 24 * 60 * 60 * 1000;
const MISSING_CACHE_EXPIRY_HOURS = 2;
const MISSING_CACHE_EXPIRY_MS = MISSING_CACHE_EXPIRY_HOURS * 60 * 60 * 1000;
const CACHE_SAVE_DEBOUNCE_MS = 1000;
const MUTATION_SCAN_DEBOUNCE_MS = 150;

class NetflixRatingsExtension {
  constructor() {
    this.processedTitles = new WeakSet();
    this.observedTitles = new WeakSet();
    this.ratingCache = new Map();
    this.blacklist = [];
    this.observer = null;
    this.intersectionObserver = null;
    this.pendingRequests = new Map();
    this.pendingRtEnrichment = new Map();
    this.debounceTimer = null;
    this.cacheSaveTimer = null;
    this.titleSelectorString = null;
    this.init();
  }

  async init() {
    await this.loadCache();
    await this.loadBlacklist();
    this.startObserving();
    this.setupIntersectionObserver();
    this.processTitles();

    window.addEventListener('popstate', () => {
      this.debounce(() => this.processTitles(), 500);
    });

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.blacklist) {
        this.loadBlacklist().then(() => this.refreshBadgesForBlacklistChange());
      }
    });

    window.addEventListener('pagehide', () => {
      this.flushCacheWrites();
    });

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        this.flushCacheWrites();
      }
    });
  }

  debounce(func, wait) {
    clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(func, wait);
  }

  async loadCache() {
    try {
      const result = await chrome.storage.local.get('ratingCache');
      if (result.ratingCache) {
        const now = Date.now();
        Object.entries(result.ratingCache).forEach(([key, value]) => {
          const isMissing = Boolean(value?.missing);
          if (!isMissing) {
            // Successful ratings are fairly stable; refresh monthly.
            if (value.timestamp && (now - value.timestamp < SUCCESS_CACHE_EXPIRY_MS)) {
              this.ratingCache.set(key, value);
            }
            return;
          }

          // Missing lookups should retry after a short cooldown.
          if (value.timestamp && (now - value.timestamp < MISSING_CACHE_EXPIRY_MS)) {
            this.ratingCache.set(key, value);
          }
        });

        // Save back if we pruned anything (optional optimization)
        if (this.ratingCache.size < Object.keys(result.ratingCache).length) {
          this.saveCache();
        }
      }
    } catch (error) {
      console.log('Failed to load cache:', error);
    }
  }

  async saveCache() {
    try {
      this.cacheSaveTimer = null;
      const cacheObj = Object.fromEntries(this.ratingCache);
      await chrome.storage.local.set({ ratingCache: cacheObj });
    } catch (error) {
      console.log('Failed to save cache:', error);
    }
  }

  scheduleCacheSave() {
    if (this.cacheSaveTimer) {
      clearTimeout(this.cacheSaveTimer);
    }

    this.cacheSaveTimer = setTimeout(() => {
      this.saveCache();
    }, CACHE_SAVE_DEBOUNCE_MS);
  }

  flushCacheWrites() {
    if (this.cacheSaveTimer) {
      clearTimeout(this.cacheSaveTimer);
      this.cacheSaveTimer = null;
    }
    this.saveCache();
  }

  async loadBlacklist() {
    try {
      const result = await chrome.storage.local.get('blacklist');
      this.blacklist = result.blacklist || [];
    } catch (error) {
      console.log('Failed to load blacklist:', error);
    }
  }

  getTitleSelectors() {
    return [
      '[data-testid="title-card"]',
      '[data-uia="search-gallery-video-card"]',
      '.title-card-container',
      '.slider-item',
      '.slider-refocus[href*="/watch/"]',
      'a[href*="/watch/"][aria-label]',
      'a[href*="jbv="][aria-label]',
      '.title-card',
      '.bob-card',
      '.previewModal--container',
      '.jawBoneContainer',
      '[data-testid="preview-modal"]',
      '[role="dialog"]'
    ];
  }

  getTitleSelectorString() {
    if (!this.titleSelectorString) {
      this.titleSelectorString = this.getTitleSelectors().join(',');
    }
    return this.titleSelectorString;
  }

  getTitleElements() {
    return document.querySelectorAll(this.getTitleSelectorString());
  }

  resolveTitleElement(element) {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) {
      return null;
    }

    const stableContainer = element.closest(
      '[data-testid="title-card"], [data-uia="search-gallery-video-card"], .title-card-container, .slider-item, .title-card, .boxart-container, .boxart-size-16x9, .previewModal--container, .jawBoneContainer, [data-testid="preview-modal"], [role="dialog"]'
    );

    return stableContainer || element;
  }

  getNormalizedTitleElements() {
    const rawElements = this.getTitleElements();
    const normalized = [];
    const seen = new Set();

    rawElements.forEach(raw => {
      const resolved = this.resolveTitleElement(raw);
      if (!resolved || seen.has(resolved)) {
        return;
      }
      seen.add(resolved);
      normalized.push(resolved);
    });

    return normalized;
  }

  isExtensionNode(element) {
    if (!element || !element.classList) return false;
    return element.classList.contains('rt-badge') || element.classList.contains('rt-blacklist-overlay');
  }

  isPotentialTitleNode(node) {
    if (!node || node.nodeType !== Node.ELEMENT_NODE) {
      return false;
    }

    const element = /** @type {Element} */ (node);
    if (this.isExtensionNode(element) || element.closest('.rt-badge, .rt-blacklist-overlay')) {
      return false;
    }

    const selector = this.getTitleSelectorString();
    if (element.matches(selector)) {
      return true;
    }

    return Boolean(element.querySelector(selector));
  }

  hasRelevantMutations(mutations) {
    for (const mutation of mutations) {
      if (mutation.type !== 'childList' || mutation.addedNodes.length === 0) {
        continue;
      }

      for (const node of mutation.addedNodes) {
        if (this.isPotentialTitleNode(node)) {
          return true;
        }
      }
    }

    return false;
  }

  startObserving() {
    this.observer = new MutationObserver((mutations) => {
      if (!this.hasRelevantMutations(mutations)) {
        return;
      }
      this.debounce(() => this.processTitles(), MUTATION_SCAN_DEBOUNCE_MS);
    });

    this.observer.observe(document.body, {
      childList: true,
      subtree: true
    });
  }

  setupIntersectionObserver() {
    this.intersectionObserver = new IntersectionObserver(
      (entries) => {
        entries.forEach(entry => {
          if (entry.isIntersecting) {
            const didProcess = this.processTitle(entry.target);
            this.intersectionObserver.unobserve(entry.target);
            this.observedTitles.delete(entry.target);
            if (!didProcess) {
              this.debounce(() => this.processTitles(), MUTATION_SCAN_DEBOUNCE_MS);
            }
          }
        });
      },
      { rootMargin: '50px' }
    );
  }

  processTitles() {
    const elements = this.getNormalizedTitleElements();
    elements.forEach(element => {
      if (!this.processedTitles.has(element) && !this.observedTitles.has(element)) {
        this.observedTitles.add(element);
        this.intersectionObserver.observe(element);
      }
    });
  }

  refreshBadgesForBlacklistChange() {
    const elements = this.getNormalizedTitleElements();
    elements.forEach(element => this.syncBadgeStateForElement(element));
  }

  syncBadgeStateForElement(titleElement) {
    const titleText = this.extractTitleText(titleElement);
    if (!titleText) return;

    const blacklistBadge = titleElement.querySelector('.rt-badge-blacklist');
    const standardBadge = titleElement.querySelector('.rt-badge:not(.rt-badge-blacklist)');
    const overlay = titleElement.querySelector('.rt-blacklist-overlay');

    if (this.isBlacklisted(titleText)) {
      if (standardBadge) {
        standardBadge.remove();
      }
      if (!blacklistBadge || !overlay) {
        this.createBlacklistBadge(titleElement, titleText);
      }
      return;
    }

    if (overlay) {
      overlay.remove();
    }
    if (blacklistBadge) {
      blacklistBadge.remove();
    }

    if (!standardBadge) {
      this.addRatingBadge(titleElement, titleText);
    }
  }

  processTitle(titleElement) {
    if (this.processedTitles.has(titleElement) || titleElement.querySelector('.rt-badge')) {
      return true;
    }

    const titleText = this.extractTitleText(titleElement);
    if (!titleText) return false;

    this.processedTitles.add(titleElement);
    this.addRatingBadge(titleElement, titleText);
    return true;
  }

  getTitleCandidateFromElement(element) {
    if (!element) return '';
    if (element.tagName === 'IMG' && element.alt) {
      return element.alt;
    }
    const ariaLabel = element.getAttribute && element.getAttribute('aria-label');
    if (ariaLabel) {
      return ariaLabel;
    }
    return element.textContent || '';
  }

  isLikelyActionLabel(text) {
    if (!text) return true;
    const normalized = text.toLowerCase().replace(/\s+/g, ' ').trim();
    if (!normalized) return true;

    const genericLabels = new Set([
      'play',
      'resume',
      'watch',
      'watch now',
      'details',
      'more info',
      'my list',
      'rate',
      'thumbs up',
      'thumbs down',
      'episode',
      'episodes',
      'new episode',
      'next episode',
      'trailer'
    ]);

    if (genericLabels.has(normalized)) return true;
    if (normalized.length < 2) return true;
    return false;
  }

  extractTitleText(element) {
    // Selectors ordered by reliability
    const titleSelectors = [
      '.fallback-text',
      '.bob-title',
      '.title-card-title',
      '.previewModal--player-titleTreatment-logo',
      '.previewModal--metadatAndControls-info h3',
      '.jawBoneTitle',
      '[data-uia="video-title"]',
      'img[alt]',
      '[aria-label]'
    ];

    for (const selector of titleSelectors) {
      const titleElements = element.querySelectorAll(selector);
      for (const titleEl of titleElements) {
        const cleaned = this.cleanTitle(this.getTitleCandidateFromElement(titleEl));
        if (cleaned) {
          return cleaned;
        }
      }
    }

    const dataTitle = element.getAttribute('data-title');
    if (dataTitle) {
      const cleanedDataTitle = this.cleanTitle(dataTitle);
      if (cleanedDataTitle) return cleanedDataTitle;
    }

    if (element.getAttribute('aria-label')) {
      const cleanedAria = this.cleanTitle(element.getAttribute('aria-label'));
      if (cleanedAria) return cleanedAria;
    }

    return null;
  }

  cleanTitle(title) {
    if (!title) return '';
    const cleaned = title
      .replace(/^(Play|Resume|My List|More Info|Rate|Thumbs Up|Thumbs Down|Watch)\b[:\s-]*/i, '')
      .replace(/\s+/g, ' ')
      .trim();

    if (this.isLikelyActionLabel(cleaned)) {
      return '';
    }
    return cleaned;
  }

  async addRatingBadge(titleElement, titleText) {
    if (this.isBlacklisted(titleText)) {
      this.createBlacklistBadge(titleElement, titleText);
      return;
    }

    try {
      // Check cache first
      if (this.ratingCache.has(titleText)) {
        const cached = this.ratingCache.get(titleText);
        // Only show if it's not a "missing" record
        if (cached && !cached.missing) {
          this.createBadge(titleElement, cached.ratings);
          if (cached.ratings && !cached.ratings.critics) {
            this.enrichWithRottenTomatoes(titleText, cached.ratings);
          }
        }
        return;
      }

      // If already pending, wait for it
      if (this.pendingRequests.has(titleText)) {
        await this.pendingRequests.get(titleText);
        // Re-check cache after wait
        if (this.ratingCache.has(titleText)) {
          const cached = this.ratingCache.get(titleText);
          if (cached && !cached.missing) {
            this.createBadge(titleElement, cached.ratings);
            if (cached.ratings && !cached.ratings.critics) {
              this.enrichWithRottenTomatoes(titleText, cached.ratings);
            }
          }
        }
        return;
      }

      const requestPromise = this.fetchRating(titleText);
      this.pendingRequests.set(titleText, requestPromise);

      const ratings = await requestPromise;
      this.pendingRequests.delete(titleText);

      if (ratings) {
        this.createBadge(titleElement, ratings);
      }
    } catch (error) {
      console.log(`Failed to get ratings for "${titleText}":`, error);
      this.pendingRequests.delete(titleText);
    }
  }

  isBlacklisted(titleText) {
    return this.blacklist.some(blacklisted =>
      titleText.toLowerCase().includes(blacklisted.toLowerCase())
    );
  }

  createBlacklistBadge(titleElement, titleText) {
    const existingOverlay = titleElement.querySelector('.rt-blacklist-overlay');
    const existingBadge = titleElement.querySelector('.rt-badge-blacklist');
    if (existingOverlay && existingBadge) {
      return;
    }

    const overlay = document.createElement('div');
    overlay.className = 'rt-blacklist-overlay';

    const badge = document.createElement('div');
    badge.className = 'rt-badge rt-badge-blacklist';

    const isModal = titleElement.closest('.previewModal--container, .jawBoneContainer, [role="dialog"]');
    if (isModal) {
      badge.classList.add('rt-badge-modal');
    }

    badge.innerHTML = `
      <div class="rt-badge-content">
        <div class="rt-blacklist-warning">
          <span class="rt-icon">🚫</span>
          <span class="rt-warning-text">Low Quality</span>
        </div>
      </div>
    `;

    if (!isModal && !titleElement.style.position) {
      titleElement.style.position = 'relative';
    }
    titleElement.appendChild(overlay);
    titleElement.appendChild(badge);
  }

  generateTitleVariations(title) {
    const variations = [title];

    const cleanedTitle = title.replace(/[:\-–—]/g, ' ').replace(/\s+/g, ' ').trim();
    if (cleanedTitle !== title) variations.push(cleanedTitle);

    const withoutYear = title.replace(/\s*\(?\d{4}\)?$/g, '').trim();
    if (withoutYear !== title) variations.push(withoutYear);

    const withoutSpecialChars = title.replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
    if (withoutSpecialChars !== title) variations.push(withoutSpecialChars);

    const withoutArticles = title.replace(/^(The|A|An)\s+/i, '').trim();
    if (withoutArticles !== title) variations.push(withoutArticles);

    return [...new Set(variations)];
  }

  async fetchRating(titleText) {
    const variations = this.generateTitleVariations(titleText);

    // Try OMDb first via Background
    for (const variation of variations) {
      try {
        const response = await chrome.runtime.sendMessage({
          action: 'getRatings',
          title: variation
        });

        if (response && response.Response === 'True') {
          const rtRating = response.Ratings?.find(r => r.Source === 'Rotten Tomatoes');
          const imdbRating = response.imdbRating && response.imdbRating !== 'N/A' ? response.imdbRating + '/10' : null;

          if (rtRating || imdbRating) {
            const omdbRatings = {
              critics: rtRating ? rtRating.Value : null,
              audience: imdbRating,
              title: response.Title,
              year: response.Year
            };

            // If OMDb has Rotten Tomatoes, we're done.
            if (omdbRatings.critics) {
              this.cacheResult(titleText, omdbRatings);
              return omdbRatings;
            }

            // Show IMDb immediately and enrich with RT asynchronously.
            this.cacheResult(titleText, omdbRatings);
            this.enrichWithRottenTomatoes(titleText, omdbRatings);
            return omdbRatings;
          }
        }
      } catch (error) {
        console.log(`OMDb check failed for "${variation}":`, error);
      }
    }

    // Fallback to scraping via Background
    try {
      const response = await chrome.runtime.sendMessage({
        action: 'searchRottenTomatoes',
        title: titleText
      });

      if (response && response.ratings) {
        this.cacheResult(titleText, response.ratings);
        return response.ratings;
      }
    } catch (error) {
      console.log('RT search failed:', error);
    }

    // If nothing found, cache as missing to avoid retry loop
    this.cacheResult(titleText, null, true);
    return null;
  }

  async enrichWithRottenTomatoes(titleText, baseRatings) {
    if (this.pendingRtEnrichment.has(titleText)) {
      return this.pendingRtEnrichment.get(titleText);
    }

    const enrichmentPromise = (async () => {
      try {
        const response = await chrome.runtime.sendMessage({
          action: 'searchRottenTomatoes',
          title: titleText
        });

        if (response && response.ratings && response.ratings.critics) {
          const mergedRatings = {
            critics: response.ratings.critics,
            audience: baseRatings?.audience || response.ratings.audience || null,
            title: baseRatings?.title || response.ratings.title || titleText,
            year: baseRatings?.year || null,
            url: response.ratings.url
          };

          this.cacheResult(titleText, mergedRatings);
          this.updateVisibleBadgesForTitle(titleText, mergedRatings);
        }
      } catch (error) {
        console.log(`RT enrichment failed for "${titleText}":`, error);
      } finally {
        this.pendingRtEnrichment.delete(titleText);
      }
    })();

    this.pendingRtEnrichment.set(titleText, enrichmentPromise);
    return enrichmentPromise;
  }

  updateVisibleBadgesForTitle(titleText, ratings) {
    const target = titleText.toLowerCase();
    const elements = this.getNormalizedTitleElements();

    elements.forEach(element => {
      const elementTitle = this.extractTitleText(element);
      if (!elementTitle || elementTitle.toLowerCase() !== target) {
        return;
      }
      if (this.isBlacklisted(elementTitle)) {
        return;
      }

      const existingBadge = element.querySelector('.rt-badge:not(.rt-badge-blacklist)');
      if (existingBadge) {
        existingBadge.remove();
      }
      this.createBadge(element, ratings);
    });
  }

  cacheResult(key, ratings, missing = false) {
    const cacheItem = {
      ratings,
      missing,
      timestamp: Date.now()
    };
    this.ratingCache.set(key, cacheItem);
    this.scheduleCacheSave();
  }

  createBadge(titleElement, ratings) {
    if (titleElement.querySelector('.rt-badge:not(.rt-badge-blacklist)')) {
      return;
    }

    const badge = document.createElement('div');
    badge.className = 'rt-badge';

    const isModal = titleElement.closest('.previewModal--container, .jawBoneContainer, [role="dialog"]');
    if (isModal) {
      badge.classList.add('rt-badge-modal');
    }

    let badgeHTML = '<div class="rt-badge-content">';

    if (ratings.critics) {
      badgeHTML += `
        <div class="rt-score critics">
          <span class="rt-icon">🍅</span>
          <span class="rt-percentage">${ratings.critics}</span>
        </div>
      `;
    }

    if (ratings.audience) {
      badgeHTML += `
        <div class="rt-score audience">
          <span class="rt-icon">⭐</span>
          <span class="rt-percentage">${ratings.audience}</span>
        </div>
      `;
    }

    badgeHTML += '</div>';
    badge.innerHTML = badgeHTML;

    if (!isModal && !titleElement.style.position) {
      titleElement.style.position = 'relative';
    }
    titleElement.appendChild(badge);
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { NetflixRatingsExtension };
} else if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    new NetflixRatingsExtension();
  });
} else {
  new NetflixRatingsExtension();
}
