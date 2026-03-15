import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'

// Polyfill window.storage with localStorage (async API expected by App.jsx)
window.storage = {
  get: async (key) => {
    const value = localStorage.getItem(key);
    return value ? { value } : null;
  },
  set: async (key, value) => {
    localStorage.setItem(key, value);
  },
};

ReactDOM.createRoot(document.getElementById('root')).render(<App />)
