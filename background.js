// Background script for Netflix Rotten Tomatoes extension
chrome.runtime.onInstalled.addListener(() => {
  console.log('Netflix Rotten Tomatoes extension installed');
});

// Handle any background tasks or API requests if needed
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'getRatings') {
    // This could be used for API requests that need to bypass CORS
    fetch(`https://www.omdbapi.com/?t=${encodeURIComponent(request.title)}&apikey=trilogy`)
      .then(response => response.json())
      .then(data => sendResponse(data))
      .catch(error => sendResponse({ error: error.message }));
    
    return true; // Indicates we will send a response asynchronously
  }
});