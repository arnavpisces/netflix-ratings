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
});
