class NetflixRatingsExtension {
  constructor() {
    this.processedTitles = new WeakSet();
    this.ratingCache = new Map();
    this.blacklist = [];
    this.observer = null;
    this.intersectionObserver = null;
    this.pendingRequests = new Map();
    this.requestQueue = [];
    this.isProcessing = false;
    this.debounceTimer = null;
    this.maxConcurrentRequests = 3;
    this.activeRequests = 0;
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
        this.ratingCache = new Map(Object.entries(result.ratingCache));
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
      const ratings = await this.getRatings(titleText);
      if (ratings) {
        this.createBadge(titleElement, ratings);
      }
    } catch (error) {
      console.log(`Failed to get ratings for "${titleText}":`, error);
    }
  }

  isBlacklisted(titleText) {
    return this.blacklist.some(blacklisted => 
      titleText.toLowerCase().includes(blacklisted.toLowerCase())
    );
  }

  createBlacklistBadge(titleElement, titleText) {
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
          <span class="rt-warning-text">Unwatchable</span>
        </div>
      </div>
    `;

    const rect = titleElement.getBoundingClientRect();
    if (rect.width > 100 && rect.height > 100) {
      titleElement.style.position = 'relative';
      titleElement.appendChild(badge);
    }
  }

  async getRatings(titleText) {
    if (this.ratingCache.has(titleText)) {
      return this.ratingCache.get(titleText);
    }

    if (this.pendingRequests.has(titleText)) {
      return this.pendingRequests.get(titleText);
    }

    const requestPromise = this.queueRequest(titleText);
    this.pendingRequests.set(titleText, requestPromise);

    try {
      const ratings = await requestPromise;
      this.pendingRequests.delete(titleText);
      return ratings;
    } catch (error) {
      this.pendingRequests.delete(titleText);
      throw error;
    }
  }

  queueRequest(titleText) {
    return new Promise((resolve, reject) => {
      this.requestQueue.push({ titleText, resolve, reject });
      this.processQueue();
    });
  }

  async processQueue() {
    if (this.isProcessing || this.requestQueue.length === 0) {
      return;
    }

    this.isProcessing = true;

    while (this.requestQueue.length > 0 && this.activeRequests < this.maxConcurrentRequests) {
      const { titleText, resolve, reject } = this.requestQueue.shift();
      this.activeRequests++;

      this.fetchRating(titleText)
        .then(ratings => {
          resolve(ratings);
          this.activeRequests--;
          this.processQueue();
        })
        .catch(error => {
          reject(error);
          this.activeRequests--;
          this.processQueue();
        });
    }

    this.isProcessing = false;
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
    
    for (const variation of variations) {
      try {
        const response = await fetch(
          `https://www.omdbapi.com/?t=${encodeURIComponent(variation)}&apikey=trilogy`
        );
        
        const data = await response.json();
        
        if (data.Response === 'True') {
          const rtRating = data.Ratings?.find(r => r.Source === 'Rotten Tomatoes');
          const imdbRating = data.imdbRating && data.imdbRating !== 'N/A' ? data.imdbRating + '/10' : null;
          
          if (rtRating || imdbRating) {
            const ratings = {
              critics: rtRating ? rtRating.Value : null,
              audience: imdbRating,
              title: data.Title,
              year: data.Year
            };
            
            this.ratingCache.set(titleText, ratings);
            
            if (this.ratingCache.size % 10 === 0) {
              this.saveCache();
            }
            
            return ratings;
          }
        }
      } catch (error) {
        console.log(`API request failed for "${variation}":`, error);
      }
    }

    const rtData = await this.searchRottenTomatoes(titleText);
    if (rtData) {
      this.ratingCache.set(titleText, rtData);
      if (this.ratingCache.size % 10 === 0) {
        this.saveCache();
      }
      return rtData;
    }

    return null;
  }

  async searchRottenTomatoes(titleText) {
    try {
      const response = await chrome.runtime.sendMessage({
        action: 'searchRottenTomatoes',
        title: titleText
      });
      
      if (response && response.ratings) {
        return response.ratings;
      }
    } catch (error) {
      console.log('RT search failed:', error);
    }
    return null;
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
