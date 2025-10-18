chrome.runtime.onInstalled.addListener(() => {
  console.log('Netflix Rotten Tomatoes extension installed');
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'getRatings') {
    fetch(`https://www.omdbapi.com/?t=${encodeURIComponent(request.title)}&apikey=trilogy`)
      .then(response => response.json())
      .then(data => sendResponse(data))
      .catch(error => sendResponse({ error: error.message }));
    
    return true;
  }
  
  if (request.action === 'searchRottenTomatoes') {
    searchRottenTomatoesAPI(request.title)
      .then(ratings => sendResponse({ ratings }))
      .catch(error => {
        console.log('RT search error:', error);
        sendResponse({ ratings: null });
      });
    
    return true;
  }
});

async function searchRottenTomatoesAPI(title) {
  try {
    const searchQuery = encodeURIComponent(title.toLowerCase().replace(/\s+/g, '_'));
    const response = await fetch(`https://www.rottentomatoes.com/search?search=${encodeURIComponent(title)}`);
    const html = await response.text();
    
    const movieMatch = html.match(/href="(\/m\/[^"]+)"/);
    if (!movieMatch) return null;
    
    const moviePath = movieMatch[1];
    const movieResponse = await fetch(`https://www.rottentomatoes.com${moviePath}`);
    const movieHtml = await movieResponse.text();
    
    const tomatometer = movieHtml.match(/tomatometerscore["\s:]+(\d+)/i);
    const audienceScore = movieHtml.match(/audiencescore["\s:]+(\d+)/i);
    
    if (tomatometer || audienceScore) {
      return {
        critics: tomatometer ? `${tomatometer[1]}%` : null,
        audience: audienceScore ? `${audienceScore[1]}%` : null,
        title: title
      };
    }
  } catch (error) {
    console.log('RT scraping failed:', error);
  }
  
  return null;
}