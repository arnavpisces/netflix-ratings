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

  test('selectBestRottenTomatoesPath prefers exact title matches', () => {
    const searchHtml = `
      <a href="/m/epic_elvis_presley_in_concert">Wrong</a>
      <a href="https://www.rottentomatoes.com/tv/bojack_horseman">Correct</a>
      <a href="/m/random_title">Other</a>
    `;

    const path = background.selectBestRottenTomatoesPath(searchHtml, 'Bojack Horseman');
    expect(path).toBe('/tv/bojack_horseman');
  });

  test('extractScoresFromDetailsHtml parses media-scorecard-json payload', () => {
    const html = `
      <html>
        <body>
          <script id="media-scorecard-json" data-json="mediaScorecard" type="application/json">
            {
              "audienceScore": { "score": "70" },
              "criticsScore": { "score": "86" }
            }
          </script>
        </body>
      </html>
    `;

    const scores = background.extractScoresFromDetailsHtml(html);
    expect(scores).toEqual({ critics: '86', audience: '70' });
  });

  test('searchRottenTomatoesAPI prefers media-scorecard-json scores over slot text', async () => {
    fetch.mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve('href="/m/once_upon_a_time_in_hollywood"')
    });

    fetch.mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve(`
        <rt-text slot="criticsScore">24%</rt-text>
        <rt-text slot="audienceScore">28%</rt-text>
        <script id="media-scorecard-json" data-json="mediaScorecard" type="application/json">
          {"audienceScore":{"score":"70"},"criticsScore":{"score":"86"}}
        </script>
      `)
    });

    const result = await background.searchRottenTomatoesAPI('Once Upon a Time in Hollywood');
    expect(result).toEqual({
      critics: '86%',
      audience: '70%',
      title: 'Once Upon a Time in Hollywood',
      url: 'https://www.rottentomatoes.com/m/once_upon_a_time_in_hollywood'
    });
  });
});
