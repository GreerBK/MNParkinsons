import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'

// Self-hosted fonts (bundled by Vite) — no Google Fonts request, faster
// first paint, and no visitor data shared with third parties.
import '@fontsource/dm-sans/400.css'
import '@fontsource/dm-sans/500.css'
import '@fontsource/dm-sans/600.css'
import '@fontsource/dm-sans/700.css'
import '@fontsource/dm-serif-display/400.css'
import '@fontsource/dm-serif-display/400-italic.css'

import './index.css'

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
