const requestQueue = [];
let isProcessing = false;
const DELAY_MS = 2000; // Base delay to avoid rate limiting
const JITTER_MS = 1500; // Random additional delay to look human

chrome.runtime.onInstalled.addListener(() => {
  console.log('Netflix Rotten Tomatoes extension installed');
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'getRatings') {
    handleOMDbRequest(request.title)
      .then(data => sendResponse(data))
      .catch(error => sendResponse({ error: error.message }));
    return true; // Keep message channel open
  }
  
  if (request.action === 'searchRottenTomatoes') {
    enqueueRottenTomatoesRequest(request.title)
      .then(ratings => sendResponse({ ratings }))
      .catch(error => {
        console.error('RT search error:', error);
        sendResponse({ ratings: null });
      });
    return true; // Keep message channel open
  }
});

function enqueueRottenTomatoesRequest(title) {
  return new Promise((resolve, reject) => {
    requestQueue.push({ title, resolve, reject });
    processQueue();
  });
}

async function processQueue() {
  if (isProcessing || requestQueue.length === 0) return;
  isProcessing = true;

  while (requestQueue.length > 0) {
    const { title, resolve, reject } = requestQueue.shift();
    
    try {
      const result = await searchRottenTomatoesAPI(title);
      resolve(result);
    } catch (e) {
      reject(e);
    }

    // Rate limiting delay
    if (requestQueue.length > 0) {
      await new Promise(r => setTimeout(r, DELAY_MS + Math.random() * JITTER_MS));
    }
  }
  
  isProcessing = false;
}

async function handleOMDbRequest(title) {
  // Using 'trilogy' key (default from original code) - in production, consider user-provided key
  const response = await fetch(`https://www.omdbapi.com/?t=${encodeURIComponent(title)}&apikey=trilogy`);
  if (!response.ok) throw new Error('OMDb API error');
  return response.json();
}

function normalizeForMatch(text) {
  if (!text) return '';
  return text
    .toLowerCase()
    .replace(/&amp;/g, ' and ')
    .replace(/[_-]/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractRottenTomatoesCandidates(searchHtml) {
  const regex = /href="(https?:\/\/www\.rottentomatoes\.com\/(?:m|tv)\/[^"?#]+|\/(?:m|tv)\/[^"?#]+)"/gi;
  const candidates = new Set();
  let match = null;

  while ((match = regex.exec(searchHtml)) !== null) {
    const href = match[1];
    const path = href.replace(/^https?:\/\/www\.rottentomatoes\.com/i, '');
    candidates.add(path);
  }

  return Array.from(candidates);
}

function scoreCandidatePath(path, title) {
  const slug = path.replace(/^\/(?:m|tv)\//, '');
  const normalizedSlug = normalizeForMatch(decodeURIComponent(slug));
  const normalizedTitle = normalizeForMatch(title);

  if (!normalizedSlug || !normalizedTitle) return 0;
  if (normalizedSlug === normalizedTitle) return 1000;
  if (normalizedSlug.includes(normalizedTitle)) return 750;
  if (normalizedTitle.includes(normalizedSlug)) return 700;

  const slugTokens = new Set(normalizedSlug.split(' ').filter(Boolean));
  const titleTokens = new Set(normalizedTitle.split(' ').filter(Boolean));
  if (slugTokens.size === 0 || titleTokens.size === 0) return 0;

  let overlap = 0;
  for (const token of titleTokens) {
    if (slugTokens.has(token)) overlap += 1;
  }

  const overlapRatio = overlap / titleTokens.size;
  if (overlapRatio === 0) return 0;

  const sizePenalty = Math.abs(slugTokens.size - titleTokens.size);
  return overlap * 100 + Math.round(overlapRatio * 100) - sizePenalty * 3;
}

function selectBestRottenTomatoesPath(searchHtml, title) {
  const candidates = extractRottenTomatoesCandidates(searchHtml);
  if (candidates.length === 0) return null;

  let bestPath = null;
  let bestScore = 0;

  for (const path of candidates) {
    const score = scoreCandidatePath(path, title);
    if (score > bestScore) {
      bestScore = score;
      bestPath = path;
    }
  }

  if (bestPath) return bestPath;
  return candidates[0];
}

function extractScoreFromMediaScorecardJson(detailsHtml) {
  const mediaScorecardMatch = detailsHtml.match(
    /<script[^>]*id="media-scorecard-json"[^>]*>([\s\S]*?)<\/script>/i
  );

  if (!mediaScorecardMatch) return { critics: null, audience: null };

  try {
    const parsed = JSON.parse(mediaScorecardMatch[1].trim());
    const critics = parsed?.criticsScore?.score ? String(parsed.criticsScore.score) : null;
    const audience = parsed?.audienceScore?.score ? String(parsed.audienceScore.score) : null;
    return { critics, audience };
  } catch (error) {
    return { critics: null, audience: null };
  }
}

function extractScoresFromDetailsHtml(detailsHtml) {
  let critics =
    detailsHtml.match(/tomatometerscore=["']?\s*(\d+)/i)?.[1] ||
    detailsHtml.match(/critics-score\s*score="(\d+)"/i)?.[1] ||
    null;

  let audience =
    detailsHtml.match(/audiencescore=["']?\s*(\d+)/i)?.[1] ||
    detailsHtml.match(/audience-score\s*score="(\d+)"/i)?.[1] ||
    null;

  if (!critics || !audience) {
    const mediaJsonScores = extractScoreFromMediaScorecardJson(detailsHtml);
    critics = critics || mediaJsonScores.critics;
    audience = audience || mediaJsonScores.audience;
  }

  // Final fallback for embedded JSON blobs not under media-scorecard-json.
  if (!critics) {
    critics = detailsHtml.match(/"criticsScore"\s*:\s*\{[\s\S]*?"score"\s*:\s*"(\d+)"/i)?.[1] || null;
  }
  if (!audience) {
    audience = detailsHtml.match(/"audienceScore"\s*:\s*\{[\s\S]*?"score"\s*:\s*"(\d+)"/i)?.[1] || null;
  }

  // Lowest-confidence fallback: slot text can be present for embedded widgets.
  if (!critics) {
    critics = detailsHtml.match(/slot="criticsScore"[^>]*>\s*(\d+)%/i)?.[1] || null;
  }
  if (!audience) {
    audience = detailsHtml.match(/slot="audienceScore"[^>]*>\s*(\d+)%/i)?.[1] || null;
  }

  return { critics, audience };
}

async function searchRottenTomatoesAPI(title) {
  try {
    // 1. Search for the movie/show
    const searchResponse = await fetch(`https://www.rottentomatoes.com/search?search=${encodeURIComponent(title)}`);
    if (!searchResponse.ok) return null;
    const searchHtml = await searchResponse.text();
    
    const relativeUrl = selectBestRottenTomatoesPath(searchHtml, title);
    if (!relativeUrl) return null;
    const detailsUrl = `https://www.rottentomatoes.com${relativeUrl}`;
    
    // 2. Fetch details page
    const detailsResponse = await fetch(detailsUrl);
    if (!detailsResponse.ok) return null;
    const detailsHtml = await detailsResponse.text();
    const scores = extractScoresFromDetailsHtml(detailsHtml);

    if (scores.critics || scores.audience) {
      return {
        critics: scores.critics ? `${scores.critics}%` : null,
        audience: scores.audience ? `${scores.audience}%` : null,
        title: title,
        url: detailsUrl
      };
    }
  } catch (error) {
    console.error('RT scraping failed:', error);
  }
  
  return null;
}

if (typeof module !== 'undefined') {
  module.exports = {
    enqueueRottenTomatoesRequest,
    processQueue,
    searchRottenTomatoesAPI,
    handleOMDbRequest,
    selectBestRottenTomatoesPath,
    extractScoresFromDetailsHtml
  };
}
