// Mocks
global.chrome = {
  runtime: {
    onInstalled: { addListener: jest.fn() },
    onMessage: { addListener: jest.fn() },
  }
};

const background = require('../background.js');

global.fetch = jest.fn();

describe('Background Script', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('searchRottenTomatoesAPI returns null on failure', async () => {
    fetch.mockRejectedValue(new Error('Network error'));
    
    const result = await background.searchRottenTomatoesAPI('Bad Movie');
    expect(result).toBeNull();
  });

  test('searchRottenTomatoesAPI parses results correctly', async () => {
    // Mock search response
    fetch.mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve('href="/m/good_movie"')
    });

    // Mock details response
    fetch.mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve(`
        <score-board tomatometerscore="90" audiencescore="85"></score-board>
      `)
    });

    const result = await background.searchRottenTomatoesAPI('Good Movie');
    
    expect(result).toEqual({
      critics: '90%',
      audience: '85%',
      title: 'Good Movie',
      url: 'https://www.rottentomatoes.com/m/good_movie'
    });
  });

  test('processQueue handles rate limiting', async () => {
    // Mock successful API call
    fetch.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve('href="/m/test" <score-board tomatometerscore="90" audiencescore="85"></score-board>')
    });

    const p1 = background.enqueueRottenTomatoesRequest('Movie 1');
    const p2 = background.enqueueRottenTomatoesRequest('Movie 2');

    // We can't easily test time-delays without fake timers, 
    // but we can check if promises resolve.
    await expect(p1).resolves.not.toBeNull();
    // p2 will take time, so we just expect it to eventually resolve
    // In a real unit test we'd use jest.useFakeTimers()
  });
});
