# Netflix Rotten Tomatoes Ratings Extension

A Chrome extension that displays Rotten Tomatoes critics ratings and IMDb audience ratings as badges on Netflix titles.

## Features

- Shows ratings as small badges on Netflix title cards
- Displays both critics (🍅) and audience (⭐) ratings
- Works across all Netflix layouts (homepage, browse, search results)
- Responsive design that adapts to different screen sizes
- Cached ratings to improve performance

## Installation

1. Download or clone this repository
2. Open Chrome and go to `chrome://extensions/`
3. Enable "Developer mode" in the top right
4. Click "Load unpacked" and select the extension folder
5. Navigate to Netflix.com and enjoy ratings on titles!

## How it Works

The extension uses:
- **Content Script**: Injects into Netflix pages to detect titles
- **OMDB API**: Fetches Rotten Tomatoes and IMDb ratings (free API)
- **Mutation Observer**: Automatically detects new titles as you browse
- **CSS Badges**: Overlays rating information on title cards

## Files

- `manifest.json` - Extension configuration
- `content.js` - Main logic for detecting titles and adding badges
- `styles.css` - Badge styling and animations  
- `background.js` - Service worker for API requests
- `README.md` - This file

## Privacy

This extension only accesses Netflix.com pages and makes API requests to fetch publicly available movie ratings. No personal data is collected or stored.

## API Usage

Uses the free OMDB API with a public key. For production use, consider getting your own API key from [omdbapi.com](http://omdbapi.com).