const CACHE_EXPIRY_DAYS = 7;
const CACHE_EXPIRY_MS = CACHE_EXPIRY_DAYS * 24 * 60 * 60 * 1000;

class NetflixRatingsExtension {
  constructor() {
    this.processedTitles = new WeakSet();
    this.ratingCache = new Map();
    this.blacklist = [];
    this.observer = null;
    this.intersectionObserver = null;
    this.pendingRequests = new Map();
    this.requestQueue = []; // Queue for UI updates if needed, but network queue is now in background
    this.debounceTimer = null;
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
        this.loadBlacklist();
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
          // Check for expiry
          if (value.timestamp && (now - value.timestamp < CACHE_EXPIRY_MS)) {
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
      const cacheObj = Object.fromEntries(this.ratingCache);
      await chrome.storage.local.set({ ratingCache: cacheObj });
    } catch (error) {
      console.log('Failed to save cache:', error);
    }
  }

  async loadBlacklist() {
    try {
      const result = await chrome.storage.local.get('blacklist');
      this.blacklist = result.blacklist || [];
    } catch (error) {
      console.log('Failed to load blacklist:', error);
    }
  }

  startObserving() {
    this.observer = new MutationObserver(() => {
      this.debounce(() => this.processTitles(), 300);
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
            this.processTitle(entry.target);
          }
        });
      },
      { rootMargin: '50px' }
    );
  }

  processTitles() {
    const titleSelectors = [
      '[data-testid="title-card"]',
      '.title-card-container',
      '.slider-item',
      '.title-card',
      '.bob-card',
      '.previewModal--container',
      '.jawBoneContainer',
      '[data-testid="preview-modal"]',
      '[role="dialog"]'
    ];

    const elements = document.querySelectorAll(titleSelectors.join(','));
    elements.forEach(element => {
      if (!this.processedTitles.has(element)) {
        this.intersectionObserver.observe(element);
      }
    });
  }

  processTitle(titleElement) {
    if (this.processedTitles.has(titleElement) || titleElement.querySelector('.rt-badge')) {
      return;
    }

    const titleText = this.extractTitleText(titleElement);
    if (!titleText) return;

    this.processedTitles.add(titleElement);
    this.addRatingBadge(titleElement, titleText);
  }

  extractTitleText(element) {
    // Selectors ordered by reliability
    const titleSelectors = [
      '.fallback-text',
      '.bob-title',
      'img[alt]',
      '[aria-label]',
      '.title-card-title',
      '.previewModal--player-titleTreatment-logo',
      '.previewModal--metadatAndControls-info h3',
      '.jawBoneTitle',
      '[data-uia="video-title"]'
    ];

    for (const selector of titleSelectors) {
      const titleEl = element.querySelector(selector);
      if (titleEl) {
        if (titleEl.tagName === 'IMG' && titleEl.alt) {
          return this.cleanTitle(titleEl.alt);
        }
        if (titleEl.getAttribute('aria-label')) {
          return this.cleanTitle(titleEl.getAttribute('aria-label'));
        }
        if (titleEl.textContent) {
          return this.cleanTitle(titleEl.textContent);
        }
      }
    }

    if (element.getAttribute('aria-label')) {
      return this.cleanTitle(element.getAttribute('aria-label'));
    }
    
    return null;
  }

  cleanTitle(title) {
    if (!title) return '';
    return title
      .replace(/^(Play|Resume|My List|More Info|Rate|Thumbs Up|Thumbs Down)/i, '')
      .replace(/\s+/g, ' ')
      .trim();
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

    const rect = titleElement.getBoundingClientRect();
    if (rect.width > 100 && rect.height > 100) {
      titleElement.style.position = 'relative';
      titleElement.appendChild(overlay);
      titleElement.appendChild(badge);
    }
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
            const ratings = {
              critics: rtRating ? rtRating.Value : null,
              audience: imdbRating,
              title: response.Title,
              year: response.Year
            };
            
            this.cacheResult(titleText, ratings);
            return ratings;
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

  cacheResult(key, ratings, missing = false) {
    const cacheItem = {
      ratings,
      missing,
      timestamp: Date.now()
    };
    this.ratingCache.set(key, cacheItem);
    
    // Save periodically
    if (this.ratingCache.size % 5 === 0) {
      this.saveCache();
    }
  }

  createBadge(titleElement, ratings) {
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

    const rect = titleElement.getBoundingClientRect();
    if (rect.width > 100 && rect.height > 100) {
      titleElement.style.position = 'relative';
      titleElement.appendChild(badge);
    }
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    new NetflixRatingsExtension();
  });
} else {
  new NetflixRatingsExtension();
}

if (typeof module !== 'undefined') {
  module.exports = { NetflixRatingsExtension };
}
