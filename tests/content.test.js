// Mocks
const mockChrome = {
  storage: {
    local: {
      get: jest.fn(),
      set: jest.fn(),
    },
    onChanged: {
      addListener: jest.fn(),
    }
  },
  runtime: {
    sendMessage: jest.fn(),
  }
};

global.chrome = mockChrome;

const { NetflixRatingsExtension } = require('../content.js');

global.MutationObserver = class {
  observe() {}
  disconnect() {}
};

global.IntersectionObserver = class {
  constructor(callback) {
    this.callback = callback;
  }
  observe() {}
  disconnect() {}
};

describe('NetflixRatingsExtension', () => {
  let extension;

  beforeEach(() => {
    jest.clearAllMocks();
    document.body.innerHTML = '';
    // Mock default storage
    mockChrome.storage.local.get.mockResolvedValue({});
  });

  test('cleanTitle removes unwanted prefixes', () => {
    // We instantiate to access methods, though in reality it runs init()
    extension = new NetflixRatingsExtension();
    const result = extension.cleanTitle('Play Stranger Things');
    expect(result).toBe('Stranger Things');
  });

  test('cleanTitle removes watch prefix from aria-label titles', () => {
    extension = new NetflixRatingsExtension();
    const result = extension.cleanTitle('Watch The Rookie');
    expect(result).toBe('The Rookie');
  });

  test('extractTitleText skips generic action labels and picks real title', () => {
    extension = new NetflixRatingsExtension();

    const container = document.createElement('div');
    const playButton = document.createElement('button');
    playButton.setAttribute('aria-label', 'Play');
    const watchLink = document.createElement('a');
    watchLink.setAttribute('aria-label', 'Watch The Rookie');

    container.appendChild(playButton);
    container.appendChild(watchLink);

    const title = extension.extractTitleText(container);
    expect(title).toBe('The Rookie');
  });

  test('resolveTitleElement prefers stable slider container over hover-only anchor', () => {
    extension = new NetflixRatingsExtension();

    const sliderItem = document.createElement('div');
    sliderItem.className = 'slider-item';
    const hoverAnchor = document.createElement('a');
    hoverAnchor.className = 'slider-refocus';
    hoverAnchor.href = '/watch/123';
    sliderItem.appendChild(hoverAnchor);

    const resolved = extension.resolveTitleElement(hoverAnchor);
    expect(resolved).toBe(sliderItem);
  });

  test('getTitleSelectors includes search gallery cards', () => {
    extension = new NetflixRatingsExtension();
    const selectors = extension.getTitleSelectors();
    expect(selectors).toContain('[data-uia="search-gallery-video-card"]');
    expect(selectors).toContain('a[href*="jbv="][aria-label]');
  });

  test('processTitle returns false when title metadata is not ready', () => {
    extension = new NetflixRatingsExtension();
    const card = document.createElement('a');
    card.setAttribute('data-uia', 'search-gallery-video-card');
    card.href = '/search?q=kill&jbv=81478985';
    card.innerHTML = '<img alt="" />';

    const result = extension.processTitle(card);
    expect(result).toBe(false);
  });

  test('generateTitleVariations creates correct variations', () => {
    extension = new NetflixRatingsExtension();
    const variations = extension.generateTitleVariations('The Matrix (1999)');
    expect(variations).toContain('The Matrix (1999)');
    expect(variations).toContain('The Matrix'); // without year
    expect(variations).toContain('Matrix (1999)'); // without article
  });

  test('cacheResult stores data with timestamp', () => {
    extension = new NetflixRatingsExtension();
    const ratings = { critics: '90%', audience: '85%' };
    
    // Mock Date.now
    const now = 1000;
    jest.spyOn(Date, 'now').mockReturnValue(now);

    extension.cacheResult('Test Movie', ratings);
    
    expect(extension.ratingCache.has('Test Movie')).toBe(true);
    const cached = extension.ratingCache.get('Test Movie');
    expect(cached.ratings).toEqual(ratings);
    expect(cached.timestamp).toBe(now);
  });

  test('syncBadgeStateForElement updates badges when blacklist changes', async () => {
    extension = new NetflixRatingsExtension();
    extension.blacklist = ['Stranger'];

    const titleElement = document.createElement('div');
    titleElement.className = 'title-card-container';
    titleElement.getBoundingClientRect = () => ({ width: 200, height: 200 });

    const titleText = document.createElement('div');
    titleText.className = 'fallback-text';
    titleText.textContent = 'Stranger Things';
    titleElement.appendChild(titleText);
    document.body.appendChild(titleElement);

    extension.syncBadgeStateForElement(titleElement);
    expect(titleElement.querySelector('.rt-badge-blacklist')).not.toBeNull();
    expect(titleElement.querySelector('.rt-blacklist-overlay')).not.toBeNull();

    extension.blacklist = [];
    const addRatingSpy = jest.spyOn(extension, 'addRatingBadge').mockResolvedValue();
    extension.syncBadgeStateForElement(titleElement);

    expect(titleElement.querySelector('.rt-badge-blacklist')).toBeNull();
    expect(titleElement.querySelector('.rt-blacklist-overlay')).toBeNull();
    expect(addRatingSpy).toHaveBeenCalledWith(titleElement, 'Stranger Things');
  });

  test('cacheResult debounces cache persistence', () => {
    jest.useFakeTimers();
    extension = new NetflixRatingsExtension();
    const saveSpy = jest.spyOn(extension, 'saveCache').mockResolvedValue();

    extension.cacheResult('Movie A', { critics: '90%' });
    extension.cacheResult('Movie B', { critics: '80%' });

    expect(saveSpy).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1000);
    expect(saveSpy).toHaveBeenCalledTimes(1);
    jest.useRealTimers();
  });

  test('fetchRating returns IMDb immediately and starts RT enrichment when OMDb lacks RT', async () => {
    extension = new NetflixRatingsExtension();
    const enrichSpy = jest.spyOn(extension, 'enrichWithRottenTomatoes').mockResolvedValue();
    mockChrome.runtime.sendMessage.mockResolvedValueOnce({
      Response: 'True',
      Title: 'BoJack Horseman',
      Year: '2014',
      imdbRating: '8.8',
      Ratings: [{ Source: 'Internet Movie Database', Value: '8.8/10' }]
    });

    const ratings = await extension.fetchRating('Bojack Horseman');

    expect(ratings).toEqual({
      critics: null,
      audience: '8.8/10',
      title: 'BoJack Horseman',
      year: '2014'
    });
    expect(enrichSpy).toHaveBeenCalledWith('Bojack Horseman', {
      critics: null,
      audience: '8.8/10',
      title: 'BoJack Horseman',
      year: '2014'
    });
  });

  test('enrichWithRottenTomatoes merges critics into cache', async () => {
    extension = new NetflixRatingsExtension();
    const updateSpy = jest.spyOn(extension, 'updateVisibleBadgesForTitle').mockImplementation(() => {});

    mockChrome.runtime.sendMessage.mockResolvedValueOnce({
      ratings: {
        critics: '93%',
        audience: '96%',
        title: 'BoJack Horseman',
        url: 'https://www.rottentomatoes.com/tv/bojack_horseman'
      }
    });

    await extension.enrichWithRottenTomatoes('Bojack Horseman', {
      critics: null,
      audience: '8.8/10',
      title: 'BoJack Horseman',
      year: '2014'
    });

    const cached = extension.ratingCache.get('Bojack Horseman');
    expect(cached.ratings).toEqual({
      critics: '93%',
      audience: '8.8/10',
      title: 'BoJack Horseman',
      year: '2014',
      url: 'https://www.rottentomatoes.com/tv/bojack_horseman'
    });
    expect(updateSpy).toHaveBeenCalledWith('Bojack Horseman', cached.ratings);
  });

  test('loadCache keeps successful ratings for a month and expires missing entries quickly', async () => {
    const now = 1_700_000_000_000;
    jest.spyOn(Date, 'now').mockReturnValue(now);

    mockChrome.storage.local.get.mockResolvedValue({
      ratingCache: {
        keepRegular: { ratings: { critics: '90%' }, missing: false, timestamp: now - (20 * 24 * 60 * 60 * 1000) },
        dropRegular: { ratings: { critics: '80%' }, missing: false, timestamp: now - (40 * 24 * 60 * 60 * 1000) },
        keepMissing: { ratings: null, missing: true, timestamp: now - (1 * 60 * 60 * 1000) },
        dropMissing: { ratings: null, missing: true, timestamp: now - (2 * 24 * 60 * 60 * 1000) }
      }
    });

    extension = new NetflixRatingsExtension();
    await Promise.resolve();
    await Promise.resolve();

    expect(extension.ratingCache.has('keepRegular')).toBe(true);
    expect(extension.ratingCache.has('dropRegular')).toBe(false);
    expect(extension.ratingCache.has('keepMissing')).toBe(true);
    expect(extension.ratingCache.has('dropMissing')).toBe(false);
  });
});
