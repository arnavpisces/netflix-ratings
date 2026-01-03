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

async function searchRottenTomatoesAPI(title) {
  try {
    // 1. Search for the movie/show
    const searchResponse = await fetch(`https://www.rottentomatoes.com/search?search=${encodeURIComponent(title)}`);
    if (!searchResponse.ok) return null;
    const searchHtml = await searchResponse.text();
    
    // Extract the first movie/tv match URL
    // Looking for specific RT patterns. This is fragile and may need updates.
    // We prioritize movies (/m/) but could also check tv (/tv/)
    const match = searchHtml.match(/href="([^"]*\/(?:m|tv)\/[^"]+)"/);
    if (!match) return null;
    
    const relativeUrl = match[1];
    const detailsUrl = `https://www.rottentomatoes.com${relativeUrl}`;
    
    // 2. Fetch details page
    const detailsResponse = await fetch(detailsUrl);
    if (!detailsResponse.ok) return null;
    const detailsHtml = await detailsResponse.text();
    
    // 3. Extract scores using Regex (fragile, relies on RT DOM structure)
    // Updated regex to be slightly more robust to whitespace
    const tomatometer = detailsHtml.match(/tomatometerscore=["']?\s*(\d+)/i) || 
                        detailsHtml.match(/critics-score\s*score="(\d+)"/i); // newer RT custom elements
                        
    const audienceScore = detailsHtml.match(/audiencescore=["']?\s*(\d+)/i) ||
                          detailsHtml.match(/audience-score\s*score="(\d+)"/i);

    if (tomatometer || audienceScore) {
      return {
        critics: tomatometer ? `${tomatometer[1]}%` : null,
        audience: audienceScore ? `${audienceScore[1]}%` : null,
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
    handleOMDbRequest
  };
}
