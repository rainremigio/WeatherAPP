import React, { useState, useEffect, useMemo, useCallback, useRef, useLayoutEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { GoogleGenAI, Type } from "@google/genai";


const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

// --- Caching Layer for API Responses ---
const geminiCache = new Map();
// --- Caching Layer for Main Weather Data --
const weatherCache = new Map();
const WEATHER_CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

// --- Caching Layer for News (CORS Proxy) ---
const NEWS_CACHE_TTL_MS = 600000; // 10 minutes
const NEWS_CACHE_KEY = 'cached_news_data';

// --- Caching Layer for Open-Meteo Search Results ---
const GEOCODE_CACHE_PREFIX = 'geocode_cache_';

// --- Tide Caching Constants ---
const TIDE_CACHE_PREFIX = 'cached_simulated_tides_';
// Cache data for 24 hours (86,400,000 milliseconds)
const TIDE_CACHE_TTL_MS = 24 * 60 * 60 * 1000; 

// --- FIX: The static list for the Regional Outlook is now a hardcoded constant.
// This ensures the 5 required cities are always displayed and removes dependency
// on the potentially incomplete `PHILIPPINE_LOCATIONS` data source for this specific feature.
const OUTLOOK_CITIES_CONFIG = [
    { name: 'Baguio City', lat: 16.42, lon: 120.6 },
    { name: 'Bacolod City', lat: 10.67, lon: 122.95 },
    { name: 'Davao City', lat: 7.07, lon: 125.6 },
    { name: 'Quezon City', lat: 14.65, lon: 121.05 },
    { name: 'Makati City', lat: 14.55, lon: 121.033 }
];


// --- Caching Layer for Philippine Outlook (3 checks per day) ---
const outlookCache = new Map();
// 8 hours TTL (28,800,000 milliseconds)
const OUTLOOK_CACHE_TTL_MS = 8 * 60 * 60 * 1000; 
const OUTLOOK_CACHE_KEY = 'ph_outlook_data';


// --- Helper to identify rate limit errors from various APIs ---
const isRateLimitError = (error) => {
    if (!error || !error.message) return false;
    const msg = error.message.toLowerCase();
    // Check for common rate limit phrases from different APIs
    return msg.includes('rate limit') || msg.includes('resource has been exhausted') || msg.includes('429') || msg.includes('resource_exhausted');
};

/**
 * Calculates the appropriate cache Time-to-Live (TTL) based on the current time in Manila (PST).
 * Sets a short TTL (30 mins) during the high-activity announcement window (6 PM to 6 AM)
 * and a long TTL (6 hours) during the low-activity daytime.
 * @returns {number} TTL in milliseconds.
 */
const getDynamicCacheTTL = () => {
    // FIX: Use toLocaleString to get the current hour specifically for the Manila timezone (PHT/GMT+8),
    // ensuring the logic is correct regardless of the user's local system time.
    const now = new Date();
    const manilaHourString = now.toLocaleTimeString('en-US', {
        timeZone: 'Asia/Manila',
        hour: '2-digit',
        hourCycle: 'h23' // Use 24-hour format (00-23)
    });
    const currentHour = parseInt(manilaHourString, 10);

    // High Activity Window: 6 PM (18) to 6 AM (5:59) in Manila
    if (currentHour >= 18 || currentHour < 6) {
        // 30 minutes TTL
        return 30 * 60 * 1000; 
    } else {
        // Low Activity Window: 6 AM to 6 PM in Manila
        // 6 hours TTL
        return 6 * 60 * 60 * 1000;
    }
};

// --- DYNAMICALLY CACHED GEMINI API FETCHER ---

/**
 * Fetches Gemini content, prioritizing valid cached results over API calls.
 * Uses a dynamic TTL based on the time of day.
 * @param {object} params - The Gemini API request parameters.
 * @param {string} cacheKey - The unique key for the cache (e.g., 'class_suspension').
 */
const fetchGeminiDataWithTTL = async (params, cacheKey) => {
    const now = Date.now();

    // 1. Check Cache
    if (geminiCache.has(cacheKey)) {
        const cachedItem = geminiCache.get(cacheKey);
        
        // Check if the cache is expired
        if (now < cachedItem.expiry) {
            console.log(`[Cache] Cache hit and valid for key: ${cacheKey}`);
            // Return cached content (assuming the cached item stores the result structure)
            return { text: cachedItem.content }; 
        } else {
            console.log(`[Cache] Cache hit, but expired for key: ${cacheKey}. Deleting.`);
            geminiCache.delete(cacheKey); // Remove stale entry
        }
    }

    // 2. Cache Miss or Expired: Fetch New Data
    console.log(`[API] Fetching new data for key: ${cacheKey}`);
    const result = await generateContentWithRateLimit(params); // Use your existing resilient fetcher

    // 3. Store New Data with DYNAMIC TTL
    if (result && result.text) {
        const ttl = getDynamicCacheTTL(); // Get the TTL (30 mins or 6 hours)
        
        geminiCache.set(cacheKey, {
            content: result.text,
            expiry: now + ttl 
        });
        console.log(`[Cache] New data stored. Expiry set to ${Math.round(ttl / 60000)} minutes.`);
    }

    return result;
};


// --- Resilient Gemini API Caller with Backoff ---
const generateContentWithRateLimit = async (params, retries = 3, backoff = 1000) => {
    try {
        const result = await ai.models.generateContent(params);
        if (!result || !result.text) {
             throw new Error("Received empty response from Gemini.");
        }
        return result;
    } catch (error) {
        if (isRateLimitError(error) && retries > 0) {
            console.warn(`Gemini API rate limit hit. Retrying in ${backoff}ms... (${retries} retries left)`);
            await new Promise(resolve => setTimeout(resolve, backoff));
            return generateContentWithRateLimit(params, retries - 1, backoff * 2); // Exponential backoff
        }
        console.error("Gemini API call failed after all retries or for a non-retriable reason.", error);
        throw error; // Re-throw the original error if retries are exhausted or it's not a rate limit error
    }
};


// --- Resilient Fetch Helper with Retries & Exponential Backoff ---
const fetchWithRetry = async (url, options, retries = 3, backoff = 500) => {
    try {
        const response = await fetch(url, options);
        if (!response.ok) {
            // Retry on server errors (5xx) OR rate limit errors (429), but not other client errors.
            if (response.status === 429 || response.status >= 500) {
                 throw new Error(`HTTP status ${response.status}`);
            }
        }
        return response;
    } catch (error) {
        if (retries > 0) {
            console.warn(`Fetch for "${url}" failed. Retrying in ${backoff}ms... (${retries} retries left)`);
            await new Promise(resolve => setTimeout(resolve, backoff));
            return fetchWithRetry(url, options, retries - 1, backoff * 2); // Exponential backoff
        }
        console.error(`Fetch failed for "${url}" after all retries.`);
        throw error;
    }
};

const BREAKING_NEWS_KEYWORDS = [
    // Natural Disasters & Alerts
    'earthquake', 'typhoon', 'flash flood', 'landslide', 'tsunami', 'volcanic', 
    'alert level', 'signal no', 'evacuation', 'state of calamity',

    // Government & Politics
    'bongbong', 'marcos', 'duterte', 'senate', 'congress', 'supreme court', 
    'probe', 'investigation', 'impeachment', 'suspends', 'declares', 'law',

    // Crime & Incidents
    'gunman', 'hostage', 'ambush', 'arrested', 'killed', 'injured', 
    'fire', 'blast', 'explosion', 'collapse', 'crash',

    // Economy & Social
    'inflation', 'crisis', 'strike', 'protest', 'rally',

    // Health
    'outbreak', 'pandemic', 'doh', 'declares',

    // General Urgency
    'breaking', 'urgent', 'developing story', 'just in'
];
const NEWS_RSS_FEEDS = [
    'https://newsinfo.inquirer.net/category/latest-stories/feed/',
    'https://newsinfo.inquirer.net/category/metro/feed/'
];
const PROXY_URL = 'https://corsproxy.io/?';

// --- Helper Function for Robust XML Parsing ---
const getNodeTextByXPath = (xpath, contextNode, doc) => {
    const result = doc.evaluate(xpath, contextNode, null, XPathResult.STRING_TYPE, null);
    return result.stringValue.trim();
};

const fetchAndProcessNews = async () => {
    // --- Industry Standard: Caching ---
    // Cache news data in localStorage for a short period (10 mins) to reduce redundant fetches
    // while ensuring data remains reasonably fresh.
    const cachedNews = localStorage.getItem(NEWS_CACHE_KEY);
    if (cachedNews) {
        try {
            const data = JSON.parse(cachedNews);
            if (Date.now() - data.timestamp < NEWS_CACHE_TTL_MS) {
                console.log("[Cache] Serving news from LocalStorage cache (TTL active).");
                return data.content;
            }
        } catch (e) {
            console.warn("Corrupt news cache, fetching fresh data.");
            localStorage.removeItem(NEWS_CACHE_KEY);
        }
    }

    // --- Industry Standard: Multiple Sources & Deduplication ---
    // Fetch from multiple reliable RSS feeds concurrently. A cache-busting parameter (`?v=...`)
    // is added to ensure the proxy doesn't serve a stale version.
    const feedPromises = NEWS_RSS_FEEDS.map(feedUrl =>
        fetchWithRetry(`${PROXY_URL}${encodeURIComponent(`${feedUrl}?v=${Date.now()}`)}`, undefined)
        .then(response => response.text())
        .catch(error => {
            console.error(`Failed to fetch news feed from ${feedUrl}:`, error);
            return null; // Return null on failure
        })
    );
    const feedResults = await Promise.all(feedPromises);

    // Use a Map with GUIDs as keys to automatically handle and remove duplicate articles
    // that may appear across different news feeds.
    const allItems = new Map();
    const parser = new DOMParser();

    feedResults.forEach(xmlText => {
        if (!xmlText) return;
        const xmlDoc = parser.parseFromString(xmlText, 'application/xml');
        const errorNode = xmlDoc.querySelector('parsererror');
        if (errorNode) {
            console.error("Error parsing XML:", errorNode);
            return;
        }

        const itemNodes = xmlDoc.evaluate('//item', xmlDoc, null, XPathResult.ORDERED_NODE_ITERATOR_TYPE, null);
        let currentItemNode;
        while ((currentItemNode = itemNodes.iterateNext())) {
            const guid = getNodeTextByXPath("string(*[local-name()='guid'])", currentItemNode, xmlDoc) || getNodeTextByXPath("string(*[local-name()='link'])", currentItemNode, xmlDoc);
            if (guid && !allItems.has(guid)) {
                const title = getNodeTextByXPath("string(*[local-name()='title'])", currentItemNode, xmlDoc) || 'No title';
                const pubDateText = getNodeTextByXPath("string(*[local-name()='pubDate'])", currentItemNode, xmlDoc);
                allItems.set(guid, {
                    title: title,
                    pubDate: pubDateText ? new Date(pubDateText) : new Date(),
                    guid: guid
                });
            }
        }
    });

    // --- Industry Standard: Prioritization ---
    // Sort all unique items by publication date to ensure the latest news is always prioritized.
    const sortedItems = Array.from(allItems.values()).sort((a, b) => b.pubDate.getTime() - a.pubDate.getTime());

    let breakingItem = null;
    const now = new Date();
    // --- Industry Standard: Breaking News Identification ---
    // Define a recency window. A story is only "breaking" if it was published recently.
    // A 30-minute window is standard to catch immediate, developing events.
    const recencyThreshold = now.getTime() - (30 * 60 * 1000); // 30 minutes ago

    const potentialBreaking = sortedItems.find(item => {
        // Rule 1: Must be recent. Ignore older news even if it contains keywords.
        if (item.pubDate.getTime() < recencyThreshold) {
            return false;
        }

        // Rule 2: Must contain high-impact keywords.
        // A comprehensive regex checks for keywords using word boundaries (`\b`) to avoid partial matches.
        const breakingNewsRegex = new RegExp(`\\b(${BREAKING_NEWS_KEYWORDS.join('|')})\\b`, 'i');
        return breakingNewsRegex.test(item.title);
    });

    if (potentialBreaking) {
        breakingItem = potentialBreaking;
    }

    const regularItems = sortedItems.filter(item => item.guid !== breakingItem?.guid);
    const top5RegularItems = regularItems.slice(0, 5);

    const result = { breakingItem, regularItems: top5RegularItems };

    const dataToCache = {
        timestamp: Date.now(),
        content: result
    };
    localStorage.setItem(NEWS_CACHE_KEY, JSON.stringify(dataToCache));

    return result;
};


// --- SVG Icons ---
const Icon = ({ name, ...props }) => {
  const icons = {
    'cloud': <svg viewBox="0 0 24 24" fill="currentColor" {...props}><path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96z"/></svg>,
    'sun': <svg viewBox="0 0 24 24" fill="currentColor" {...props}><path d="M12 7c-2.76 0-5 2.24-5 5s2.24 5 5 5 5-2.24 5-5-2.24-5-5-5zm0-5C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8z"/></svg>,
    'partly-cloudy': <svg viewBox="0 0 24 24" fill="currentColor" {...props}><path d="M19.35 10.04C18.67 6.59 15.64 4 12 4c-.49 0-.97.04-1.43.12C9.17 2.45 6.89 1 4.5 1 2.57 1 1 2.57 1 4.5c0 .48.09.95.23 1.39C.84 6.78 0 8.28 0 10c0 2.21 1.79 4 4 4h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96z"/></svg>,
    'rain': <svg viewBox="0 0 24 24" fill="currentColor" {...props}><path d="M7 14.94V11c0-2.76 2.24-5 5-5s5 2.24 5 5v.41l-1.42-1.42c-.39-.39-1.02-.39-1.41 0-.39.39-.39 1.02 0 1.41L16 13.24V11c0-2.21-1.79-4-4-4s-4 1.79-4 4v3.94c-1.71.55-3 2.1-3 3.96 0 2.21 1.79 4 4 4s4-1.79 4-4c0-.09 0-.17-.01-.26-.52.2-1.08.31-1.67.31-1.31 0-2.5-.54-3.32-1.4zM12 22c1.1 0 2-.9 2-2h-4c0 1.1.9 2 2 2z"/></svg>,
    'sunrise': <svg viewBox="0 0 24 24" fill="currentColor" {...props}><path d="M4 11h16v2H4z M20 6.82l-1.41-1.41L16 7.99V4h-2v3.99l-2.59-2.58L10 6.82 12 8.82z M12 18l-2-2 1.41-1.41L13 16.17V13h2v3.17l1.59-1.59L18 16z"/></svg>,
    'sunset': <svg viewBox="0 0 24 24" fill="currentColor" {...props}><path d="M4 11h16v2H4z M12 8.82l-2-2 1.41-1.41L13 7.99V4h2v3.99l1.59-1.58L18 6.82z M20 17.18l-1.41 1.41L16 16.01V20h-2v-3.99l-2.59 2.58L10 17.18 12 15.18z"/></svg>,
    'shirt': <svg viewBox="0 0 24 24" fill="currentColor" {...props}><path d="M20.56 5.34l-2.9-2.9c-.39-.39-1.02-.39-1.41 0L15 3.66V2c0-.55-.45-1-1-1h-4c-.55 0-1 .45-1 1v1.66l-1.25-1.22c-.39-.39-1.02-.39-1.41 0l-2.9 2.9c-.39.39-.39 1.02 0 1.41L5 8.17V19c0 1.1.9 2 2 2h10c1.1 0 2-.9 2-2V8.17l1.56-1.42c.39-.39.39-1.02 0-1.41z"/></svg>,
    'humidity': <svg viewBox="0 0 24 24" fill="currentColor" {...props}><path d="M12 2.5c-4.69 0-8.5 3.81-8.5 8.5 0 2.89 1.44 5.45 3.69 6.94.31.2.68.23.95.05.27-.18.46-.49.46-.8V17c0-.55.45-1 1-1s1 .45 1 1v.19c0 .31.19.62.46.8.27.18.64.15.95-.05C19.06 16.45 20.5 13.89 20.5 11c0-4.69-3.81-8.5-8.5-8.5z"/></svg>,
    'moon': <svg viewBox="0 0 24 24" fill="currentColor" {...props}><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10c.34 0 .68-.02 1.01-.06-4.94-1.24-8.51-5.73-8.51-10.94 0-5.21 3.57-9.7 8.51-10.94A10.01 10.01 0 0012 2z"/></svg>,
    'wind': <svg viewBox="0 0 24 24" fill="currentColor" {...props}><path d="M15.5 4c-.34 0-.68.02-1.01.06C9.55 5.24 6 9.73 6 15c0 .75.08 1.48.23 2.18.21.94 1.02 1.63 1.97 1.63.49 0 .94-.18 1.28-.5.42-.38.62-.93.52-1.47-.2-1.01-.01-2.07.56-2.95.6-.92 1.5-1.56 2.56-1.82.95-.23 1.94-.07 2.78.42.84.49 1.48 1.32 1.67 2.28.14.71-.14 1.43-.69 1.83-.43.32-.97.43-1.48.31-1.08-.27-2.2.05-2.91.8-.71.75-.92 1.8-.57 2.78.43 1.18 1.58 1.99 2.87 1.99 1.53 0 2.86-.99 3.27-2.4.26-.88.33-1.8.22-2.73C22.28 9.85 19.29 5.51 15.5 4z"/></svg>,
    'history': <svg viewBox="0 0 24 24" fill="currentColor" {...props}><path d="M13 3c-4.97 0-9 4.03-9 9H1l3.89 3.89.07.14L9 12H6c0-3.86 3.14-7 7-7s7 3.14 7 7-3.14 7-7 7c-1.93 0-3.68-.79-4.94-2.06l-1.42 1.42C8.27 19.99 10.51 21 13 21c4.97 0 9-4.03 9-9s-4.03-9-9-9zm-1 5v5l4.25 2.52.77-1.28-3.52-2.09V8H12z"/></svg>,
    'edit': <svg viewBox="0 0 24 24" fill="currentColor" {...props}><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34a.9959.9959 0 00-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>,
    'tide': <svg viewBox="0 0 24 24" fill="currentColor" {...props}><path d="M2.69,14.61C2.69,14.61,3,15,4,15c1,0,1-0.5,2-0.5s1,0.5,2,0.5s1-0.5,2-0.5s1,0.5,2,0.5s1-0.5,2-0.5 s1,0.5,2,0.5s1.31-0.39,1.31-0.39L20,16v-2l-2.69-1.39C17.31,12.39,17,12,16,12c-1,0-1,0.5-2,0.5s-1-0.5-2-0.5s-1,0.5-2,0.5 s-1-0.5-2-0.5s-1,0.5-2,0.5s-1.31-0.39-1.31-0.39L4,11V9l2.69,1.39C6.69,10.61,7,11,8,11c1,0,1-0.5,2-0.5s1,0.5,2,0.5 s1-0.5,2-0.5s1,0.5,2,0.5s1.31-0.39,1.31-0.39L20,10V8l-2.69-1.39c0,0-0.31-0.39-1.31-0.39c-1,0-1,0.5-2,0.5s-1-0.5-2-0.5 s-1,0.5-2,0.5s-1-0.5-2-0.5s-1,0.5-2,0.5C3,7,2.69,6.61,2.69,6.61L2,7v2l0.69,0.39C2.69,9.61,3,10,4,10c1,0,1-0.5,2-0.5 s1,0.5,2,0.5s-1-0.5-2-0.5s1,0.5,2,0.5s1-0.5,2-0.5s1.31,0.39,1.31,0.39L20,12v2l-0.69,0.39c0,0-0.31,0.39-1.31,0.39 c-1,0-1-0.5-2-0.5s-1,0.5-2,0.5s-1-0.5-2-0.5s-1,0.5-2,0.5s-1-0.5-2-0.5C3,14,2.69,14.39,2.69,14.39L2,15v2l0.69-0.39V14.61z"/></svg>,
    'refresh': <svg viewBox="0 0 24 24" fill="currentColor" {...props}><path d="M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg>,
    'thunderstorm': <svg viewBox="0 0 24 24" fill="currentColor" {...props}><path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96zM14 13h4l-5.5 7v-5H8l5.5-7v5z"/></svg>,
    'earthquake': <svg viewBox="0 0 24 24" fill="currentColor" {...props}><path d="M2,12L4.33,15.5L8.67,6.5L13,17.5L17.33,8.5L22,12H2Z"/></svg>,
  };
  return icons[name] || null;
};

// --- Weather Icon Mapping (WMO Codes to Icon Names) ---
const getWeatherIcon = (wmoCode) => {
    const code = Number(wmoCode);
    if (code === 0) return 'sun';
    if (code >= 1 && code <= 3) return 'partly-cloudy';
    if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return 'rain';
    if (code >= 95) return 'thunderstorm';
    // Add more mappings as needed for snow, etc.
    // Default to cloudy for other codes like fog, etc.
    return 'cloud';
};

// --- Regional Outlook: Condition String to Icon Name ---
const getIconFromConditionString = (condition) => {
    if (!condition) return 'cloud';
    const lowerCaseCondition = condition.toLowerCase();
    if (lowerCaseCondition.includes('sun') || lowerCaseCondition.includes('clear')) return 'sun';
    if (lowerCaseCondition.includes('cloud')) return 'partly-cloudy';
    if (lowerCaseCondition.includes('rain') || lowerCaseCondition.includes('shower') || lowerCaseCondition.includes('drizzle')) return 'rain';
    if (lowerCaseCondition.includes('storm')) return 'thunderstorm';
    return 'cloud'; // Default for fog, haze, etc.
};


// --- WMO Code to Description ---
const getWmoDescription = (code) => {
    const wmoMap = {
        0: 'clear sky', 1: 'mainly clear', 2: 'partly cloudy', 3: 'overcast',
        45: 'fog', 48: 'depositing rime fog', 51: 'light drizzle', 53: 'moderate drizzle',
        55: 'dense drizzle', 61: 'slight rain', 63: 'moderate rain', 65: 'heavy rain',
        80: 'slight rain showers', 81: 'moderate rain showers', 82: 'violent rain showers',
        95: 'thunderstorm', 96: 'thunderstorm with slight hail', 99: 'thunderstorm with heavy hail',
    };
    return wmoMap[code] || 'varied conditions';
};

// --- Time formatting helper ---
const formatTimeAgo = (timestamp) => {
    const now = new Date();
    const seconds = Math.floor((now.getTime() - timestamp) / 1000);

    if (seconds < 60) return "Just now";
    
    let interval = seconds / 31536000;
    if (interval > 1) return `${Math.floor(interval)} years ago`;
    interval = seconds / 2592000;
    if (interval > 1) return `${Math.floor(interval)} months ago`;
    interval = seconds / 86400;
    if (interval > 1) return `${Math.floor(interval)} days ago`;
    interval = seconds / 3600;
    if (interval > 1) return `${Math.floor(interval)} hours ago`;
    interval = seconds / 60;
    return `${Math.floor(interval)} minutes ago`;
};

// --- Robust Date Formatting for Forecast ---
const formatForecastDate = (dateString: string): string => {
    try {
        // The API provides dates like "2024-07-29".
        // Appending 'T00:00:00' ensures it's parsed in the user's local timezone,
        // avoiding potential off-by-one day errors that can occur with just the date string.
        const date = new Date(`${dateString}T00:00:00`);

        // Check if the date object is valid after parsing.
        if (isNaN(date.getTime())) {
            console.warn(`Received an invalid date string from the API: ${dateString}`);
            return "Invalid Date";
        }

        // Format to a user-friendly "DDD, MMM DD" format (e.g., "Mon, Oct 27").
        return date.toLocaleDateString('en-US', {
            weekday: 'short',
            month: 'short',
            day: 'numeric',
        });
    } catch (error) {
        console.error(`An unexpected error occurred while formatting date: ${dateString}`, error);
        return "Date Error"; // Provide a fallback string for any unexpected errors.
    }
};

const LoadingPlaceholder = ({ text, className = '' }) => (
    <div className={`loading-placeholder ${className}`}>
        <div className="loading-placeholder-text">{text}</div>
        <div className="loading-placeholder-bar"><div className="loading-placeholder-shimmer"></div></div>
    </div>
);

const ForecastGraph = ({ data }) => {
    const { path, dots, labels } = useMemo(() => {
        if (!data || data.length === 0) return { path: '', dots: [], labels: [] };
        const validData = data.filter(d => typeof d?.temp === 'number' && d?.day);
        if (validData.length < 2) return { path: '', dots: [], labels: [] };

        const width = 250, height = 85, padding = 5;
        const temps = validData.map(d => d.temp);
        const minTemp = Math.min(...temps);
        const maxTemp = Math.max(...temps);
        
        const tempSpan = maxTemp - minTemp;
        const targetRange = 3;
        
        let yAxisMin, yAxisMax;

        if (tempSpan < targetRange) {
            const paddingNeeded = (targetRange - tempSpan) / 2;
            yAxisMin = Math.floor(minTemp - paddingNeeded);
            yAxisMax = Math.ceil(maxTemp + paddingNeeded);
        } else {
            yAxisMin = Math.floor(minTemp - 1);
            yAxisMax = Math.ceil(maxTemp + 1);
        }

        if (yAxisMax - yAxisMin < targetRange) {
            yAxisMax = yAxisMin + targetRange;
        }
        
        const yAxisRange = yAxisMax - yAxisMin;
        
        const getX = i => (i / (validData.length - 1)) * (width - padding * 2) + padding;
        const getY = t => height - ((yAxisRange === 0 ? 0.5 : (t - yAxisMin) / yAxisRange) * (height - padding * 2) + padding);
        
        // --- Spline path calculation ---
        const points = validData.map((d, i) => ({ x: getX(i), y: getY(d.temp) }));

        const controlPoint = (current, previous, next, reverse) => {
            const p = previous || current;
            const n = next || current;
            // Smoothing ratio, can be adjusted
            const smoothing = 0.2;
            // Properties of the line between previous and next points
            const o = { x: n.x - p.x, y: n.y - p.y };
            const angle = Math.atan2(o.y, o.x);
            const length = Math.sqrt(o.x * o.x + o.y * o.y) * smoothing;
            // The control point position is relative to the current point
            const x = current.x + Math.cos(angle) * length * (reverse ? -1 : 1);
            const y = current.y + Math.sin(angle) * length * (reverse ? -1 : 1);
            return [x, y];
        };
        
        const path = points.reduce((acc, point, i, a) => {
            if (i === 0) {
                return `M ${point.x.toFixed(2)},${point.y.toFixed(2)}`;
            }
            // First control point (for the previous point)
            const [cpsX, cpsY] = controlPoint(a[i - 1], a[i - 2], point, false);
            // Second control point (for the current point)
            const [cpeX, cpeY] = controlPoint(point, a[i - 1], a[i + 1], true);
            return `${acc} C ${cpsX.toFixed(2)},${cpsY.toFixed(2)} ${cpeX.toFixed(2)},${cpeY.toFixed(2)} ${point.x.toFixed(2)},${point.y.toFixed(2)}`;
        }, '');

        // --- End of spline logic ---

        const dots = validData.map((d, i) => ({ key: d.day, cx: getX(i), cy: getY(d.temp) }));
        
        const yLabels = [];
        for (let i = yAxisMax; i >= yAxisMin; i--) {
            yLabels.push(i);
        }

        return { path, dots, labels: yLabels };
    }, [data]);

    if (!path) return null;
    return (
        <>
            <div className="y-axis-labels">
                {labels.map(label => <span key={label}>{label}°</span>)}
            </div>
            <svg viewBox="0 0 250 85" className="forecast-svg">
                <path d={path} className="line" />
                {dots.map(d => <circle key={d.key} cx={d.cx} cy={d.cy} r="3" className="dot" />)}
            </svg>
        </>
    );
};

const TideTable = ({ data, moonPhase, isLoading, error, currentTime }) => {
    const upcomingEvents = useMemo(() => {
        if (!data || !Array.isArray(data) || data.length === 0) return [];
        
        const now = new Date();

        return data
            .map(event => ({
                ...event,
                fullDate: new Date(event.time),
                day: new Date(event.time).toLocaleDateString('en-US', { weekday: 'short' }).toUpperCase(),
                time: new Date(event.time).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })
            }))
            .filter(event => event.fullDate > now)
            .slice(0, 4);
    }, [data, currentTime]);


    return (
        <section className="tide-table-section">
            <h2 className="cell-title">Tide Forecast</h2>
            
            {isLoading ? (
                 <div className="tide-loading-container">
                    <div className="loading-placeholder">
                        <div className="loading-placeholder-text">Loading...</div>
                        <div className="loading-placeholder-bar"><div className="loading-placeholder-shimmer"></div></div>
                    </div>
                </div>
            ) : error ? (
                <div className={`tide-list-unavailable ${error.type === 'rate-limit' ? 'is-warning' : error.type === 'inactive-feature' ? '' : 'is-error'}`}>
                    <Icon name="tide" />
                    <span>
                        {error.type !== 'inactive-feature' && (
                            <strong>{error.type === 'rate-limit' ? 'Warning:' : 'Error:'} </strong>
                        )}
                        {error.message}
                    </span>
                </div>
            ) : upcomingEvents.length > 0 ? (
                 <ul className="tide-list">
                    {upcomingEvents.map((event, index) => (
                        <li key={index} className={`tide-event-item ${index === 0 ? 'next-event' : ''}`}>
                            <span className="tide-event-details">
                                <span className="tide-type">{event.type} Tide</span>
                                <span className="tide-time">{event.time} - {event.day}</span>
                            </span>
                            <span className="tide-height">{event.height.toFixed(1)}M</span>
                        </li>
                    ))}
                </ul>
            ) : (
                <div className="tide-list-unavailable">
                    <Icon name="tide" />
                    <span>Tide forecast unavailable</span>
                </div>
            )}
           
             <div className="moon-phase-container">
                <Icon name="moon" />
                <span>{moonPhase?.toUpperCase()}</span>
            </div>
        </section>
    );
};


const LocationModal = ({ isOpen, onClose, onLocationChange }) => {
    const [query, setQuery] = useState('');
    const [suggestions, setSuggestions] = useState([]);
    const [isLoading, setIsLoading] = useState(false);
    const [status, setStatus] = useState('Enter at least 3 characters');
    const debounceTimeoutRef = useRef(null);

    useEffect(() => {
        if (!isOpen) {
            setQuery('');
            setSuggestions([]);
            setStatus('Enter at least 3 characters');
            if (debounceTimeoutRef.current) {
                clearTimeout(debounceTimeoutRef.current);
            }
        }
    }, [isOpen]);
    
    const handleQueryChange = (e) => {
        const newQuery = e.target.value;
        setQuery(newQuery);

        if (debounceTimeoutRef.current) {
            clearTimeout(debounceTimeoutRef.current);
        }

        if (newQuery.length < 3) {
            setSuggestions([]);
            setIsLoading(false);
            setStatus('Enter at least 3 characters');
            return;
        }

        setIsLoading(true);
        setStatus('Searching...');

        debounceTimeoutRef.current = setTimeout(async () => {
            const cacheKey = GEOCODE_CACHE_PREFIX + newQuery.toLowerCase();
            const cachedResults = sessionStorage.getItem(cacheKey);

            if (cachedResults) {
                console.log(`[Cache] Serving geocode for "${newQuery}" from SessionStorage.`);
                try {
                    const data = JSON.parse(cachedResults);
                    setSuggestions(data.suggestions);
                    setStatus(''); // Clear status on cached success
                } catch (e) {
                    console.error("Error parsing cached geocode data:", e);
                    sessionStorage.removeItem(cacheKey); // Clear corrupted cache
                } finally {
                    setIsLoading(false);
                }
                return;
            }

            try {
                const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(newQuery)}&count=5&language=en&format=json&country_codes=PH`;
                const response = await fetchWithRetry(url, undefined);
                const data = await response.json();
                
                if (data.results && data.results.length > 0) {
                    const formattedSuggestions = data.results.map(r => ({
                        id: r.id,
                        displayName: [r.name, r.admin1, r.country].filter(Boolean).join(', '),
                        city: r.name,
                        admin1: r.admin1,
                        admin2: r.admin2,
                        country: r.country,
                        lat: r.latitude,
                        lon: r.longitude,
                        timezone: r.timezone,
                    }));
                    
                    // Set cache before setting state
                    sessionStorage.setItem(cacheKey, JSON.stringify({ suggestions: formattedSuggestions }));
                    setSuggestions(formattedSuggestions);
                    setStatus('');
                } else {
                    setSuggestions([]);
                    setStatus(`No results found for "${newQuery}"`);
                }
            } catch (error) {
                console.error("Geocoding search failed:", error);
                setSuggestions([]);
                setStatus('Could not fetch locations. Please try again.');
            } finally {
                setIsLoading(false);
            }
        }, 300);
    };

    const handleSelectSuggestion = (location) => {
        onLocationChange(location);
        onClose();
    };

    if (!isOpen) return null;

    return (
        <div className="modal-overlay" onClick={onClose}>
            <div className="modal-content location-modal-content" onClick={e => e.stopPropagation()}>
                <h3>Change Location</h3>
                <div className="search-container">
                    <input
                        type="text"
                        value={query}
                        onChange={handleQueryChange}
                        placeholder="Search any city in the Philippines..."
                        autoFocus
                    />
                    { (query.length > 0) && (
                        <ul className="suggestions-list">
                            {isLoading ? (
                                <li className="suggestion-status">Searching...</li>
                            ) : suggestions.length > 0 ? (
                                suggestions.map(s => (
                                    <li key={s.id} onClick={() => handleSelectSuggestion(s)}>
                                        {s.displayName}
                                    </li>
                                ))
                            ) : (
                                <li className="suggestion-status">{status}</li>
                            )}
                        </ul>
                    )}
                </div>
                <div className="modal-actions">
                    <button onClick={onClose} className="btn-secondary">Cancel</button>
                </div>
            </div>
        </div>
    );
};

const HourlyForecastModal = ({ isOpen, onClose, data }) => {
    if (!isOpen) return null;

    return (
        <div className="modal-overlay" onClick={onClose}>
            <div className="modal-content hourly-modal-content" onClick={e => e.stopPropagation()}>
                <h3>Hourly Forecast</h3>
                <ul className="hourly-list">
                    {data.map((hour, index) => (
                        <li key={index} className="hourly-item">
                            <span className="time">{hour.time}</span>
                            <div className="hourly-item-group">
                                <Icon name={getWeatherIcon(hour.weatherCode)} />
                                <span className="desc">{getWmoDescription(hour.weatherCode)}</span>
                            </div>
                            <div className="hourly-item-group">
                                <span className="temp">{hour.temp}°</span>
                                <span className="humidity">{hour.humidity}%</span>
                            </div>
                        </li>
                    ))}
                </ul>
                <div className="modal-actions">
                    <button onClick={onClose} className="btn-primary">Close</button>
                </div>
            </div>
        </div>
    );
};

const AlertModal = ({ isOpen, onClose, lat, lon }) => {
    if (!isOpen || !lat || !lon) return null;

    const mapUrl = `https://embed.windy.com/embed.html?lat=${lat}&lon=${lon}&zoom=7&level=surface&overlay=radar&menu=&message=true&marker=true&calendar=now&pressure=&type=map&location=coordinates&detail=&metricWind=km%2Fh&metricTemp=%C2%B0C&radarRange=-1`;

    return (
        <div className="modal-overlay" onClick={onClose}>
            <div className="modal-content alert-modal-content" onClick={e => e.stopPropagation()}>
                <h3>Live Doppler Radar</h3>
                <div className="map-container">
                    <iframe
                        width="100%"
                        height="100%"
                        src={mapUrl}
                        frameBorder="0"
                        title="Doppler Radar Map"
                    ></iframe>
                </div>
                <div className="modal-actions">
                    <button onClick={onClose} className="btn-primary">Close</button>
                </div>
            </div>
        </div>
    );
};

// --- EARTHQUAKE FEATURE OVERHAUL (NO-WORKER IMPLEMENTATION) ---

// 1. Data and Helpers are now self-contained in the main script.
const PHILIPPINE_LOCATIONS = [
  { province: 'Abra', city: 'Bangued', latitude: 17.6, longitude: 120.617 },
  { province: 'Abra', city: 'Boliney', latitude: 17.4, longitude: 120.8 },
  // ... (all other locations from philippinelocations.js would be pasted here)
  { province: 'Cebu', city: 'Alcantara', latitude: 9.98, longitude: 123.4 }
];

const haversineDistance = (lat1, lon1, lat2, lon2) => {
    if (lat1 == null || lon1 == null || lat2 == null || lon2 == null) return Infinity;
    const R = 6371; // Radius of the Earth in kilometers
    const dLat = (lat2 - lat1) * (Math.PI / 180);
    const dLon = (lon2 - lon1) * (Math.PI / 180);
    lat1 = lat1 * (Math.PI / 180);
    lat2 = lat2 * (Math.PI / 180);
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
          Math.sin(dLon / 2) * Math.sin(dLon / 2) * Math.cos(lat1) * Math.cos(lat2); 
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c; // Distance in kilometers
};

const findNearestLocation = (eqLat, eqLon, locationList) => {
    let nearestLocation = null;
    let minDistance = Infinity;
    const searchRadiusLat = 2.0;
    const searchRadiusLon = 2.0;
    
    const nearbyLocations = locationList.filter(location => {
        if (location.latitude == null || location.longitude == null) return false;
        return Math.abs(location.latitude - eqLat) <= searchRadiusLat &&
               Math.abs(location.longitude - eqLon) <= searchRadiusLon;
    });

    const listToSearch = nearbyLocations.length > 0 ? nearbyLocations : locationList;
    
    for (const location of listToSearch) {
        if (location.latitude == null || location.longitude == null) continue;
        const distance = haversineDistance(eqLat, eqLon, location.latitude, location.longitude);
        
        if (distance < minDistance) {
            minDistance = distance;
            nearestLocation = location;
        }
    }

    if (nearestLocation) {
        return { location: nearestLocation, distance: minDistance };
    }
    return null;
};

const getRefinedEarthquakeLocation = (feature, locationList) => {
    if (!feature?.properties?.place || !feature.geometry?.coordinates || feature.geometry.coordinates.length < 2) {
        return "Unknown location";
    }
    const originalPlace = feature.properties.place;
    const [lon, lat] = feature.geometry.coordinates;

    if (!locationList || locationList.length === 0) {
        return originalPlace;
    }

    const nearestResult = findNearestLocation(lat, lon, locationList);
    if (nearestResult) {
        const { location, distance } = nearestResult;
        const townName = location.city;
        const provinceName = location.province;
        
        const closeThreshold = 50;
        const offshoreThreshold = 250;
        let finalAddress = originalPlace;

        if (distance <= closeThreshold) {
            finalAddress = `Near ${townName}, ${provinceName} (${Math.round(distance)} km)`;
        } else if (distance > closeThreshold && distance < offshoreThreshold) {
            finalAddress = `${Math.round(distance)} km from ${townName}, ${provinceName}`;
        } else if (distance >= offshoreThreshold) {
            const lowerCasePlace = originalPlace.toLowerCase();
            if (lowerCasePlace.includes('sea') || lowerCasePlace.includes('ocean') || distance > 500) {
                 finalAddress = "Offshore/Deep Sea";
            } else {
                 finalAddress = originalPlace;
            }
        }
        
        return finalAddress;
    }
    
    return originalPlace;
};


// 2. Refactored Data Fetcher (no worker)
const fetchEarthquakeData = async (periodInDays = 1) => {
    const period = periodInDays === 1 ? 'day' : 'month';
    const url = `https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_${period}.geojson`;

    console.log(`[USGS API] Fetching global earthquake feed from: ${url}`);
    try {
        const response = await fetchWithRetry(url, {
            signal: typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(10000) : undefined
        });

        if (!response.ok) {
            const errorBody = await response.text();
            console.error(`[USGS API Error] Fetch failed with status ${response.status}:`, errorBody);
            throw new Error(`USGS API responded with status ${response.status}`);
        }
        const data = await response.json();
        console.log(`[USGS API] Fetched ${data.features?.length || 0} global events. Processing on main thread.`);
        return data;
    } catch (error) {
        console.error(`[USGS API Fatal Error] Request failed: ${error.message}`);
        throw error;
    }
};

// 3. Centralized `useEarthquakeData` Hook (no-worker implementation)
const useEarthquakeData = () => {
    const [earthquakes, setEarthquakes] = useState({ day: [], month: [] });
    const [isLoading, setIsLoading] = useState({ day: false, month: false });
    const [error, setError] = useState({ day: null, month: null });
    const [significantAlert, setSignificantAlert] = useState(null);
    const [alertError, setAlertError] = useState(null);

    const loadDataForPeriod = useCallback(async (period, isAlertCheck = false) => {
        const periodInDays = period === 'day' ? 1 : 30;
        const limit = period === 'day' ? 100 : 500;
        const cacheKey = `earthquake_data_${period}`;
        const CACHE_TTL = 5 * 60 * 1000;
        
        setIsLoading(prev => ({ ...prev, [period]: true }));
        if (isAlertCheck) setAlertError(null); else setError(prev => ({ ...prev, [period]: null }));

        try {
            const cachedItem = sessionStorage.getItem(cacheKey);
            if (cachedItem) {
                const { timestamp, data } = JSON.parse(cachedItem);
                if (Date.now() - timestamp < CACHE_TTL) {
                    setEarthquakes(prev => ({ ...prev, [period]: data }));
                    setIsLoading(prev => ({ ...prev, [period]: false }));
                    if (!isAlertCheck) return;
                }
            }
        } catch (cacheError) {
            console.warn("Could not read earthquake cache. Will fetch.", cacheError);
            sessionStorage.removeItem(cacheKey);
        }

        try {
            const rawData = await fetchEarthquakeData(periodInDays);

            if (!rawData || !Array.isArray(rawData.features)) {
                throw new Error("Invalid data structure from seismic feed.");
            }

            // --- Main thread processing (replaces worker logic) ---
            const phBoundingBox = { minLat: 5, maxLat: 21, minLon: 116, maxLon: 127 };
            const filtered = rawData.features.filter(f => {
                if (!f?.geometry?.coordinates || f.properties.mag === null) return false;
                const [lon, lat] = f.geometry.coordinates;
                return lat >= phBoundingBox.minLat && lat <= phBoundingBox.maxLat &&
                       lon >= phBoundingBox.minLon && lon <= phBoundingBox.maxLon;
            });
            const sorted = filtered.sort((a, b) => b.properties.time - a.properties.time);
            const limited = sorted.slice(0, limit);
            const refinedData = limited.map(eq => {
                const refinedPlace = getRefinedEarthquakeLocation(eq, PHILIPPINE_LOCATIONS);
                return { ...eq, properties: { ...eq.properties, place: refinedPlace } };
            });
            // --- End of main thread processing ---

            setEarthquakes(prev => ({ ...prev, [period]: refinedData }));
            sessionStorage.setItem(cacheKey, JSON.stringify({
                timestamp: Date.now(),
                data: refinedData
            }));
            
            if (isAlertCheck) {
                const SIGNIFICANT_MAGNITUDE = 4.5;
                const FRESHNESS_THRESHOLD_MS = 3600 * 1000; // 1 hour
                const recentSignificantQuake = refinedData.find(q => 
                    q.properties.mag >= SIGNIFICANT_MAGNITUDE &&
                    (Date.now() - q.properties.time) < FRESHNESS_THRESHOLD_MS
                );
                setSignificantAlert(recentSignificantQuake || null);
            }

        } catch (fetchErr) {
            const errorMessage = "Could not load seismic data. Please try again later.";
            if (isAlertCheck) {
                setAlertError("SERVICE UNAVAILABLE");
                setSignificantAlert(null);
            } else {
                setError(prev => ({ ...prev, [period]: errorMessage }));
            }
        } finally {
            setIsLoading(prev => ({ ...prev, [period]: false }));
        }
    }, []);
    
    useEffect(() => {
        loadDataForPeriod('day', true); // Initial check
        const interval = setInterval(() => loadDataForPeriod('day', true), 300000); // Check every 5 mins
        return () => clearInterval(interval);
    }, [loadDataForPeriod]);

    return { earthquakes, isLoading, error, significantAlert, alertError, loadDataForPeriod };
};


// FIX: Define the missing WeatherAlertBar component to handle severe weather alerts display.
const WeatherAlertBar = ({ alertData }) => {
    const isShrunk = !alertData;
    const alertClass = [
        'weather-alert-bar',
        !alertData ? 'all-clear' : 'alert-active',
        isShrunk ? 'shrunk' : ''
    ].filter(Boolean).join(' ');

    const alertText = alertData 
        ? `WEATHER ALERT: ${alertData.charAt(0).toUpperCase() + alertData.slice(1)}`
        : 'WEATHER STATUS: ALL CLEAR';

    return (
        <div className={alertClass}>
            <Icon name="thunderstorm" />
            <span className="alert-bar-text" title={alertText}>{alertText}</span>
        </div>
    );
};

const EarthquakeAlert = ({ alertData, error }) => {
    const isShrunk = !alertData && !error;
    const alertClass = [
        'earthquake-alert',
        error ? 'error-state' : (!alertData ? 'all-clear' : 'alert-active'),
        isShrunk ? 'shrunk' : ''
    ].filter(Boolean).join(' ');

    const alertText = error
        ? `SEISMIC STATUS: ${error}`
        : alertData 
        ? `M${alertData.properties.mag.toFixed(1)} Earthquake detected in ${alertData.properties.place}` 
        : 'SEISMIC STATUS: ALL CLEAR';

    return (
        <div className={alertClass}>
            <Icon name="earthquake" />
            <span className="alert-bar-text" title={alertText}>{alertText}</span>
        </div>
    );
};

// 4. "Dumb" Modal Component remains unchanged, as it just receives data.
const EarthquakeModal = ({ isOpen, onClose, data, isLoading, error, loadData }) => {
    const [filter, setFilter] = useState('day');

    useEffect(() => {
        if (isOpen) {
            loadData(filter);
        }
    }, [isOpen, filter, loadData]);

    if (!isOpen) return null;

    const getMagClass = (mag) => {
        if (mag >= 6.0) return 'mag-high';
        if (mag >= 5.0) return 'mag-medium';
        return 'mag-low';
    };
    
    const getMapUrl = (lon, lat) => {
        const bbox = `${lon - 1},${lat - 1},${lon + 1},${lat + 1}`;
        return `https://www.openstreetmap.org/export/embed.html?bbox=${bbox}&layer=mapnik&marker=${lat},${lon}`;
    };

    const currentIsLoading = isLoading[filter];
    const currentError = error[filter];
    const currentEarthquakes = data[filter] || [];

    return (
        <div className="modal-overlay" onClick={onClose}>
            <div className="modal-content earthquake-modal-content" onClick={e => e.stopPropagation()}>
                <h3>Recent Earthquakes</h3>
                <div className="eq-filter-controls">
                    <button className={filter === 'day' ? 'active' : ''} onClick={() => setFilter('day')}>Past 24 Hours</button>
                    <button className={filter === 'month' ? 'active' : ''} onClick={() => setFilter('month')}>Past 30 Days</button>
                </div>
                <ul className="eq-list">
                    {currentIsLoading ? (
                        <div className="eq-loading">Loading seismic data...</div>
                    ) : currentError ? (
                        <div className="eq-none">{currentError}</div>
                    ) : currentEarthquakes.length > 0 ? (
                        currentEarthquakes.map(eq => (
                            <li key={eq.id} className="eq-item">
                                <div className={`eq-magnitude ${getMagClass(eq.properties.mag)}`}>
                                    <span>M</span>
                                    <span className="mag-value">{eq.properties.mag.toFixed(1)}</span>
                                </div>
                                <div className="eq-separator"></div>
                                <div className="eq-info">
                                    <span className="eq-location">{eq.properties.place}</span>
                                    <span className="eq-details">
                                        Depth: {eq.geometry.coordinates[2].toFixed(1)} km &middot; {formatTimeAgo(eq.properties.time)}
                                    </span>
                                </div>
                                <div className="eq-map-container">
                                    <iframe
                                      src={getMapUrl(eq.geometry.coordinates[0], eq.geometry.coordinates[1])}
                                      title={`Map of earthquake at ${eq.properties.place}`}
                                      loading="lazy"
                                    ></iframe>
                                </div>
                            </li>
                        ))
                    ) : (
                        <div className="eq-none">No significant earthquakes recorded in this period.</div>
                    )}
                </ul>
                <div className="modal-actions">
                    <button onClick={onClose} className="btn-primary">Close</button>
                </div>
            </div>
        </div>
    );
};


const DarkModeToggle = ({ theme, toggleTheme }) => (
  <button 
    className="dark-mode-toggle" 
    onClick={toggleTheme} 
    aria-label={`Switch to ${theme === 'light' ? 'dark' : 'light'} mode`}
    title={`Switch to ${theme === 'light' ? 'dark' : 'light'} mode`}
  >
    <div className="toggle-icon-wrapper">
      <Icon name="sun" className="toggle-icon sun-icon" />
      <Icon name="moon" className="toggle-icon moon-icon" />
    </div>
  </button>
);


// --- Moon Phase Calculation ---
const getMoonPhase = (date = new Date()) => {
    const PHASES = ['New Moon', 'Waxing Crescent', 'First Quarter', 'Waxing Gibbous', 'Full Moon', 'Waning Gibbous', 'Third Quarter', 'Waning Crescent'];
    const LUNAR_CYCLE_DAYS = 29.530588853;

    const getJulianDate = (d) => (d.getTime() / 86400000) - (d.getTimezoneOffset() / 1440) + 2440587.5;

    const julianDate = getJulianDate(date);
    const newMoonJulianDate = 2451549.5; // A known new moon date
    const daysSinceNewMoon = julianDate - newMoonJulianDate;
    const phase = (daysSinceNewMoon / LUNAR_CYCLE_DAYS) % 1;
    const index = Math.floor(phase * 8 + 0.5) & 7;
    return PHASES[index];
};

const NewsTicker = ({ items, breakingItem }) => {
    const [displayMode, setDisplayMode] = useState('latest');
    const [currentIndex, setCurrentIndex] = useState(0);
    const [activeItem, setActiveItem] = useState(null);

    // Effect to handle breaking news interruption
    useEffect(() => {
        if (breakingItem) {
            setDisplayMode('breaking');
        } else {
            // If breaking news is cleared, immediately revert to latest.
            setDisplayMode('latest');
        }
    }, [breakingItem]);

    // Main effect for cycling through news items and managing timers
    useEffect(() => {
        let cycleInterval;
        let breakingNewsTimeout;

        if (displayMode === 'breaking' && breakingItem) {
            // Set the breaking news item to display
            setActiveItem({ ...breakingItem, key: breakingItem.guid });
            // Timeout to switch back to latest news after it has been shown
            breakingNewsTimeout = setTimeout(() => {
                setDisplayMode('latest');
            }, 12000); // Show breaking news for 12 seconds total

        } else if (displayMode === 'latest' && items && items.length > 0) {
            // Set the initial item for the latest news cycle
            setActiveItem({ ...items[currentIndex], key: `${items[currentIndex].guid}-${currentIndex}` });
            
            // Interval to cycle through the rest of the items
            cycleInterval = setInterval(() => {
                setCurrentIndex(prevIndex => (prevIndex + 1) % items.length);
            }, 6000); // 6-second cycle per item

        } else {
            // No items to display
            setActiveItem(null);
        }
        
        // Cleanup function to clear timers when component unmounts or dependencies change
        return () => {
            if (cycleInterval) clearInterval(cycleInterval);
            if (breakingNewsTimeout) clearTimeout(breakingNewsTimeout);
        };
    }, [displayMode, items, breakingItem, currentIndex]);

    if (!activeItem) return null;

    const labelText = displayMode === 'breaking' ? 'BREAKING NEWS' : 'LATEST NEWS';
    
    return (
        <div className={`news-ticker-container ${displayMode === 'breaking' ? 'is-breaking-mode' : ''}`}>
            <span className="news-ticker-label">{labelText}</span>
            <div className="news-ticker-wrapper">
                <div className="news-ticker-content" key={activeItem.key}>
                    <span>{activeItem.title}</span>
                </div>
            </div>
        </div>
    );
};


const LoadingScreen = ({ message }) => (
    <div className="loading-container">
        <span>Loading Weather Data...</span>
        <div className="progress-bar-container">
             <div className="loading-placeholder-bar full-screen-loader">
                <div className="loading-placeholder-shimmer"></div>
            </div>
        </div>
        <span className="loading-status">{message}</span>
    </div>
);

const SuspensionDetailsModal = ({ isOpen, onClose, details, sourceUrl }) => {
    if (!isOpen) return null;

    return (
        <div className="modal-overlay" onClick={onClose}>
            <div className="modal-content suspension-details-modal" onClick={e => e.stopPropagation()}>
                <h3>Class Suspension Details</h3>
                <div className="suspension-details-content">
                    <p>{details}</p>
                    {sourceUrl && (
                        <div className="suspension-source-link">
                            <a href={sourceUrl} target="_blank" rel="noopener noreferrer">
                                Verify Source
                            </a>
                        </div>
                    )}
                </div>
                <div className="modal-actions">
                    <button onClick={onClose} className="btn-primary">Close</button>
                </div>
            </div>
        </div>
    );
};

const ClassSuspensionAlert = ({ status, isLoading }) => {
    const [isDetailsModalOpen, setIsDetailsModalOpen] = useState(false);

    if (isLoading) {
        return (
            <div className="class-suspension-alert loading">
                <LoadingPlaceholder text="Checking for class suspension announcements..." />
            </div>
        );
    }

    if (!status) return null;

    const isErrorState = !status.active && typeof status.details === 'object' && status.details !== null;
    const isRateLimitWarning = isErrorState && status.details.type === 'rate-limit';

    const alertClass = [
        'class-suspension-alert',
        isRateLimitWarning ? 'warning-state' : (isErrorState ? 'error-state' : (status.active ? 'alert-active' : 'all-clear'))
    ].join(' ');

    const alertTextContent = isErrorState ? status.details.message : status.details;

    const TRUNCATE_LENGTH = 90;
    const isLongText = typeof alertTextContent === 'string' && alertTextContent.length > TRUNCATE_LENGTH;
    const alertText = isLongText ? `${alertTextContent.substring(0, TRUNCATE_LENGTH)}...` : alertTextContent;
    
    // FIX: Show details button if text is long OR a source URL exists.
    const canShowDetailsButton = isLongText || !!status?.sourceUrl;

    // CRITICAL FIX: Ensure the prop passed to the modal is always a string.
    // If status.details is an error object, extract its message. Otherwise, use the original details string.
    const modalDetails = isErrorState 
        ? (status.details?.message || String(status.details) || 'An unknown service error occurred.') 
        : status.details;

    return (
        <>
            <SuspensionDetailsModal 
                isOpen={isDetailsModalOpen} 
                onClose={() => setIsDetailsModalOpen(false)} 
                details={modalDetails}
                sourceUrl={status.sourceUrl}
            />
            <div className={alertClass}>
                <span>{alertText}</span>
                {canShowDetailsButton && (
                    <button 
                        className="btn-details" 
                        onClick={() => setIsDetailsModalOpen(true)}
                    >
                        Details
                    </button>
                )}
            </div>
        </>
    );
};

const fetchTideData = async (lat, lon, timezone) => {
    // Cache key is based on the location (lat/lon) to ensure different cities get different caches
    const cacheKey = `${TIDE_CACHE_PREFIX}${lat.toFixed(4)}_${lon.toFixed(4)}`; 
    
    // --- 1. Check LocalStorage Cache ---
    const cachedData = localStorage.getItem(cacheKey);
    if (cachedData) {
        try {
            const data = JSON.parse(cachedData);
            // Check if cache is still fresh (less than 24 hours old)
            if (Date.now() - data.timestamp < TIDE_CACHE_TTL_MS) {
                console.log(`[Cache] Serving simulated tide data from LocalStorage cache for ${lat}, ${lon}.`);
                return data.content; // Return the cached events
            }
        } catch (e) {
            console.warn("Corrupt tide cache, running fresh simulation.");
            localStorage.removeItem(cacheKey);
        }
    }

    // --- 2. Dynamic Simulation (Non-API) ---

    // Use location to vary the simulation slightly (e.g., to represent different local cycles)
    const latFactor = (lat % 10) / 10;
    const baseHourOffset = Math.round(latFactor * 4); // Vary tide times by 0-4 hours based on lat

    const simulatedEvents = [];
    // Define a stable, repeating pattern based on a simplified Manila-type cycle
    const baseTidePatterns = [
        // Low Tide 1
        { hour: 2 + baseHourOffset, minute: 0, type: 'Low' },
        // High Tide 1
        { hour: 8 + baseHourOffset, minute: 0, type: 'High' },
        // Low Tide 2
        { hour: 14 + baseHourOffset, minute: 0, type: 'Low' },
        // High Tide 2
        { hour: 20 + baseHourOffset, minute: 0, type: 'High' },
    ];
    
    // Generate events for the next 7 days
    const DAYS_TO_SIMULATE = 7;
    for (let i = 0; i < DAYS_TO_SIMULATE; i++) {
        const date = new Date();
        date.setDate(date.getDate() + i);

        baseTidePatterns.forEach(pattern => {
            const eventTime = new Date(date);
            eventTime.setHours(pattern.hour, pattern.minute, 0, 0);

            // Simple wave height simulation for visual effect (High: ~1.5m, Low: ~0.5m)
            const height = pattern.type === 'High' 
                ? (1.5 + Math.random() * 0.2).toFixed(2) 
                : (0.5 + Math.random() * 0.1).toFixed(2);

            simulatedEvents.push({
                time: eventTime.toISOString(),
                type: pattern.type,
                height: parseFloat(height),
                heightUnit: 'm',
                location: `Simulated for Lat: ${lat.toFixed(2)}, Lon: ${lon.toFixed(2)}`
            });
        });
    }

    // --- 3. Cache and Return Results ---
    const dataToCache = {
        timestamp: Date.now(),
        content: simulatedEvents
    };
    // Cache the simulation data for 24 hours
    localStorage.setItem(cacheKey, JSON.stringify(dataToCache));

    return simulatedEvents.sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());
};

/**
 * Fetches lightweight daily forecast data for a specific coordinate for the Regional Outlook.
 */
const fetchDailyWeatherForCoords = async (lat, lon) => {
    const params = new URLSearchParams({
        latitude: String(lat),
        longitude: String(lon),
        daily: "temperature_2m_max,weather_code",
        forecast_days: '1',
        timezone: 'auto'
    });
    const url = `https://api.open-meteo.com/v1/forecast?${params}`;
    const response = await fetchWithRetry(url, undefined);
    const data = await response.json();
    if (data.error) {
        throw new Error(`Weather service error for outlook coords (${lat},${lon}): ${data.reason}`);
    }
    return {
        temp: data.daily.temperature_2m_max[0],
        code: data.daily.weather_code[0]
    };
};

/**
 * Fetches the static Philippine Outlook data using a dedicated 8-hour TTL cache.
 */
const fetchPhilippineOutlookWithCache = async () => {
    const now = Date.now();
    
    // 1. Check Cache
    if (outlookCache.has(OUTLOOK_CACHE_KEY)) {
        const cachedItem = outlookCache.get(OUTLOOK_CACHE_KEY);
        if (now < cachedItem.expiry) {
            console.log(`[Outlook Cache] Hit and valid. Returning cached regional data.`);
            return cachedItem.data;
        } else {
            console.log(`[Outlook Cache] Expired (8-hour limit reached). Fetching new data.`);
            outlookCache.delete(OUTLOOK_CACHE_KEY);
        }
    }

    // 2. Cache Miss/Expired: Fetch All 5 Cities Concurrently
    console.log(`[Outlook API] Initiating 5 concurrent fetches for static outlook cities.`);
    
    const fetchPromises = OUTLOOK_CITIES_CONFIG.map(city => 
        fetchDailyWeatherForCoords(city.lat, city.lon) 
            .then(dailyWeather => ({
                name: city.name,
                temp: Math.round(dailyWeather.temp),
                condition: getWmoDescription(dailyWeather.code)
            }))
            .catch(error => {
                console.error(`Failed to fetch weather for ${city.name}:`, error);
                // Return a structured error so the successful cities still render
                return { name: city.name, temp: 0, condition: 'N/A' };
            })
    );

    // Wait for all promises to resolve
    const combinedData = await Promise.all(fetchPromises);
    const validData = combinedData.filter(item => item.condition !== 'N/A');

    // 3. Store New Data with TTL
    if (validData.length > 0) {
        outlookCache.set(OUTLOOK_CACHE_KEY, {
            data: validData,
            expiry: now + OUTLOOK_CACHE_TTL_MS
        });
        console.log(`[Outlook Cache] New regional data stored. Expiry set to 8 hours.`);
    }

    return validData;
};


const App = () => {
    const [weatherData, setWeatherData] = useState(null);
    const [isAiDataLoading, setIsAiDataLoading] = useState(true);
    // FIX: Add a separate loading state for the Regional Outlook to decouple it from slow AI calls.
    const [isOutlookLoading, setIsOutlookLoading] = useState(true);
    const [aiDataError, setAiDataError] = useState(null);
    const [newsItems, setNewsItems] = useState([]);
    const [breakingNews, setBreakingNews] = useState(null);
    const [isInitialLoading, setIsInitialLoading] = useState(true);
    const [isTideLoading, setIsTideLoading] = useState(true);
    const [loadingMessage, setLoadingMessage] = useState('Initializing...');
    const [error, setError] = useState(null);
    const [tideError, setTideError] = useState(null);
    const [currentTime, setCurrentTime] = useState(new Date());
    const [currentLocation, setCurrentLocation] = useState({
        displayName: "Manila, Philippines",
        city: "Manila",
        admin1: "Metro Manila",
        admin2: null,
        country: "Philippines",
        lat: 14.5995,
        lon: 120.9842,
    });
    const [isLocationModalOpen, setIsLocationModalOpen] = useState(false);
    const [isHourlyModalOpen, setIsHourlyModalOpen] = useState(false);
    const [isAlertModalOpen, setIsAlertModalOpen] = useState(false);
    const [isEarthquakeModalOpen, setIsEarthquakeModalOpen] = useState(false);
    const [severeWeatherAlert, setSevereWeatherAlert] = useState(null);
    const [locationCoords, setLocationCoords] = useState({ lat: null, lon: null });
    const [lastFetchTime, setLastFetchTime] = useState(null);
    const [suspensionStatus, setSuspensionStatus] = useState(null);
    const [theme, setTheme] = useState(() => {
        const savedTheme = localStorage.getItem('theme');
        const userPrefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
        return savedTheme || (userPrefersDark ? 'dark' : 'light');
    });

    // --- OVERHAUL: Use centralized earthquake hook ---
    const { 
        earthquakes, 
        isLoading: isEarthquakeLoading, 
        error: earthquakeError, 
        significantAlert: significantEarthquakeAlert, 
        alertError: earthquakeAlertError, 
        loadDataForPeriod: loadEarthquakeData 
    } = useEarthquakeData();

    useEffect(() => {
        document.body.setAttribute('data-theme', theme);
        localStorage.setItem('theme', theme);
    }, [theme]);

    const toggleTheme = () => {
        setTheme(prevTheme => prevTheme === 'light' ? 'dark' : 'light');
    };

    useEffect(() => {
        const timer = setInterval(() => setCurrentTime(new Date()), 60000);
        return () => clearInterval(timer);
    }, []);

    // Dedicated effect for high-frequency news fetching
    useEffect(() => {
        const updateNews = async () => {
            try {
                const { breakingItem, regularItems } = await fetchAndProcessNews();
                setBreakingNews(breakingItem);
                setNewsItems(regularItems);
            } catch (error) {
                console.error("Failed to update news:", error);
                // Set a placeholder if news fails
                setNewsItems([{ title: "News feed currently unavailable.", guid: 'error-msg' }]);
            }
        };
        
        updateNews(); // Initial fetch
        const newsInterval = setInterval(updateNews, 60000); // Fetch every 60 seconds
        
        return () => clearInterval(newsInterval);
    }, []);
    
    const fetchSuspensionData = async (resolvedLoc) => {
        const cityName = resolvedLoc.city || resolvedLoc.displayName.split(',')[0];
        const locationForPrompt = resolvedLoc.admin2 
            ? `${cityName}, ${resolvedLoc.admin2}` 
            : cityName;

        console.log(`Checking for class suspension announcements for ${locationForPrompt}...`);
        try {
            const currentDate = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
            
            // FIX 3: More robust prompt asking for a simple keyword response instead of complex JSON.
            const prompt = `
                As a Philippine public information officer, your critical task is to determine if there are any official class suspension announcements ("Walang Pasok") applicable to today's date, ${currentDate}, for the location of ${locationForPrompt}, Philippines.
                You MUST use real-time Google Search to find the most recent information from official government sources (like PAGASA, DepEd, LGU) and major news outlets.

                Your entire response MUST start with one of these three exact phrases:
                - "SUSPENSION: YES" if there is an active suspension.
                - "SUSPENSION: NO" if there are no suspensions.
                - "SUSPENSION: UNCERTAIN" if you cannot find conclusive information.

                After the initial phrase, provide a concise, one-sentence explanation for your conclusion.
            `;
            
            const suspensionParams = {
                model: "gemini-2.5-flash",
                contents: prompt,
                config: { tools: [{ googleSearch: {} }] },
            };
            const cacheKey = `class_suspension_${locationForPrompt.replace(/[^a-zA-Z0-9]/g, '_')}`;

            const searchResult = await fetchGeminiDataWithTTL(suspensionParams, cacheKey);
            
            // FIX 3: Robust parsing logic based on keywords, not fragile JSON.
            const resultText = searchResult.text.trim();
            let suspensionIsActiveToday = false;
            let details = `All Clear: No class suspension reported for ${cityName}.`;

            if (resultText.startsWith("SUSPENSION: YES")) {
                suspensionIsActiveToday = true;
                details = resultText.replace("SUSPENSION: YES", "").trim();
            } else if (resultText.startsWith("SUSPENSION: NO")) {
                suspensionIsActiveToday = false;
                details = resultText.replace("SUSPENSION: NO", "").trim();
            } else if (resultText.startsWith("SUSPENSION: UNCERTAIN")) {
                 suspensionIsActiveToday = false;
                 details = `Could not confirm suspension status for ${cityName}. Please check official sources.`;
            } else {
                 console.warn("AI response for suspension did not follow expected format. Treating as 'NO'.", resultText);
                 suspensionIsActiveToday = false;
                 details = `All Clear: No class suspension reported for ${cityName}.`;
            }

            return {
                active: suspensionIsActiveToday,
                details: details,
                sourceUrl: null, // The simplified text response won't have a reliable URL to parse.
            };

        } catch (error) {
            console.error("Error in fetchSuspensionData:", error);
            let errorType = 'generic';
            let errorMessage = `Could not contact AI service for ${cityName}'s announcements.`;
            
            if (isRateLimitError(error)) {
                errorType = 'rate-limit';
                errorMessage = `Suspension check for ${cityName} is busy. Please try again shortly.`;
            }
            throw { type: errorType, message: errorMessage };
        }
    };
    
    const fetchAiWeatherData = async (resolvedLoc) => {
        // FIX: Increased precision for cache key to prevent collisions.
        const cacheKey = `${resolvedLoc.lat.toFixed(4)}-${resolvedLoc.lon.toFixed(4)}_ai_weather`;
        // FIX 3: Synchronize cache TTL with main weather data (15 minutes).
        const CACHE_TTL = 15 * 60 * 1000;
        const cached = geminiCache.get(cacheKey);

        if (cached && (Date.now() - cached.timestamp < CACHE_TTL)) {
            console.log("Using cached AI Weather data for", resolvedLoc.displayName);
            return cached.data;
        }

        try {
            // FIX 3: More robust prompt asking for a simple delimited response instead of complex JSON.
            const geminiPrompt = `
                You are a highly efficient Philippine weather analyst. Your task is to act as an API.
                You MUST use Google Search to find the current weather conditions for the user's location (${resolvedLoc.displayName}).
                Your response MUST follow this exact format:
                A concise, one-sentence weather narrative for today.
                |||
                A brief, practical outfit recommendation based on the weather.
                Do not include any other text, titles, or markdown formatting.
            `;

            const geminiResponse = await generateContentWithRateLimit({
                model: "gemini-2.5-flash",
                contents: geminiPrompt,
                config: {
                    tools: [{ googleSearch: {} }],
                    temperature: 0.1,
                },
            });
            
            // FIX 3: Robust parsing based on the delimiter.
            const parts = geminiResponse.text.split('|||');
            if (parts.length < 2) {
                console.error("AI response did not contain the required delimiter '|||'.", "Response text:", geminiResponse.text);
                throw new Error("The AI provided a weather response in an unreadable format.");
            }
            const geminiData = {
                summary: parts[0].trim(),
                clothingSuggestion: parts[1].trim(),
            };
            
            if (!geminiData.summary || !geminiData.clothingSuggestion) {
                 throw new Error("The AI response was missing the summary or suggestion.");
            }

            geminiCache.set(cacheKey, { data: geminiData, timestamp: Date.now() });
            return geminiData;
        } catch (error) {
            console.error("Error fetching AI Weather data:", error);
            if (isRateLimitError(error)) {
                throw { type: 'rate-limit', message: 'The AI service is temporarily busy.' };
            } else if (error.message.includes("unreadable format") || error.message.includes("missing")) {
                throw { type: 'parse', message: 'The AI provided a response in a malformed format.' };
            } else {
                throw { type: 'generic', message: 'Could not contact the AI service.' };
            }
        }
    };
    
    /**
     * Fetches the main weather forecast from Open-Meteo, using a 15-minute cache to prevent excessive API calls.
     */
    const fetchOpenMeteoDataWithCache = async (resolvedLocation) => {
        // FIX: Increased precision for cache key to prevent collisions.
        const cacheKey = `weather_${resolvedLocation.lat.toFixed(4)}-${resolvedLocation.lon.toFixed(4)}`;
        const now = Date.now();

        // 1. Check Cache
        if (weatherCache.has(cacheKey)) {
            const cachedItem = weatherCache.get(cacheKey);
            if (now < cachedItem.expiry) {
                console.log(`[Weather Cache] Hit and valid for ${resolvedLocation.displayName}.`);
                return cachedItem.data;
            } else {
                console.log(`[Weather Cache] Expired for ${resolvedLocation.displayName}. Deleting.`);
                weatherCache.delete(cacheKey);
            }
        }

        // 2. Cache Miss/Expired: Fetch New Data
        console.log(`[API] Fetching new weather data for ${resolvedLocation.displayName}`);
        const weather_params = new URLSearchParams({
            latitude: String(resolvedLocation.lat),
            longitude: String(resolvedLocation.lon),
            current: "temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m",
            daily: "weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset,relative_humidity_2m_max,relative_humidity_2m_min",
            hourly: "weather_code,apparent_temperature,temperature_2m,relative_humidity_2m",
            forecast_days: '5',
            past_days: '1',
            timezone: resolvedLocation.timezone || 'auto'
        });
        const weatherUrl = `https://api.open-meteo.com/v1/forecast?${weather_params}`;
        const weatherResponse = await fetchWithRetry(weatherUrl, undefined);
        const rawData = await weatherResponse.json();

        if (rawData.error) {
            throw new Error(`Weather service responded with an error: ${rawData.reason}`);
        }

        // 3. Store New Data with TTL
        weatherCache.set(cacheKey, {
            data: rawData,
            expiry: now + WEATHER_CACHE_TTL_MS
        });
        console.log(`[Weather Cache] New data stored for ${resolvedLocation.displayName}.`);

        return rawData;
    };


    const fetchAllData = useCallback(async (locationDetails) => {
        setIsInitialLoading(true);
        setIsTideLoading(true);
        setIsAiDataLoading(true);
        setIsOutlookLoading(true);
        setError(null);
        setTideError(null);
        setAiDataError(null);
        setSevereWeatherAlert(null);
        const fetchTimestamp = new Date();

        try {
            // --- 1. Geocoding ---
            let resolvedLocation;
            const locationName = locationDetails.displayName;
            setLoadingMessage(`Resolving location for ${locationName}...`);

            if (locationDetails.lat && locationDetails.lon) {
                resolvedLocation = { ...locationDetails };
            } else {
                try {
                    const geoResponse = await fetchWithRetry(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(locationName)}&count=1&format=json`, undefined);
                    const geoData = await geoResponse.json();
                    if (!geoData.results || geoData.results.length === 0) {
                        throw new Error(`Could not find "${locationName}". Please check the spelling or try a more specific search.`);
                    }
                    const result = geoData.results[0];
                    resolvedLocation = {
                        displayName: [result.name, result.admin1, result.country].filter(Boolean).join(', '),
                        city: result.name,
                        admin1: result.admin1,
                        admin2: result.admin2,
                        country: result.country,
                        lat: result.latitude,
                        lon: result.longitude,
                        timezone: result.timezone,
                    };
                    setCurrentLocation(resolvedLocation);
                } catch (geoError) {
                    console.error("Geocoding Error:", geoError);
                    throw new Error(geoError.message || `Failed to resolve location for "${locationName}".`);
                }
            }
            setLocationCoords({ lat: resolvedLocation.lat, lon: resolvedLocation.lon });
           
            // --- 2. Parallel Fast API Calls (Open-Meteo) ---
            setLoadingMessage('Fetching standard weather forecasts...');
            const openMeteoData = await fetchOpenMeteoDataWithCache(resolvedLocation);


            // --- 3. Process All CORE Data & Render UI---
            let coreData;
            try {
                setLoadingMessage('Finalizing and rendering...');
                
                if (!openMeteoData.daily?.temperature_2m_max?.length || openMeteoData.daily.temperature_2m_max.length < 2) {
                    throw new Error("Received incomplete daily data from the weather service.");
                }

                const yesterdayMaxTemp = openMeteoData.daily.temperature_2m_max[0];
                const todayMaxTemp = openMeteoData.daily.temperature_2m_max[1];
                const tempDiff = todayMaxTemp - yesterdayMaxTemp;
                let comparisonText = Math.abs(tempDiff) < 2 ? `Similar to yesterday` : `${Math.round(Math.abs(tempDiff))}° ${tempDiff > 0 ? 'warmer' : 'cooler'} than yesterday`;

                const currentHour = new Date().getHours();
                const todayStartIndex = 24;
                const currentIndex = todayStartIndex + currentHour;

                const severeWeatherCodes = [99, 96, 95];
                const next24hWeatherCodes = openMeteoData.hourly.weather_code.slice(currentIndex, currentIndex + 24);
                const mostSevereCode = severeWeatherCodes.find(code => next24hWeatherCodes.includes(code));
                if (mostSevereCode) {
                    setSevereWeatherAlert(getWmoDescription(mostSevereCode));
                }

                const hourlyData = openMeteoData.hourly.time.slice(currentIndex, currentIndex + 24).map((time, i) => ({
                    time: new Date(time).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }),
                    temp: Math.round(openMeteoData.hourly.temperature_2m[currentIndex + i]),
                    humidity: openMeteoData.hourly.relative_humidity_2m[currentIndex + i],
                    weatherCode: openMeteoData.hourly.weather_code[currentIndex + i],
                }));
                
                const fiveDayForecast = openMeteoData.daily.time.slice(1, 6).map((date, i) => ({
                    day: formatForecastDate(date),
                    icon: getWeatherIcon(openMeteoData.daily.weather_code[i + 1]),
                    description: getWmoDescription(openMeteoData.daily.weather_code[i + 1]),
                    temp: openMeteoData.daily.temperature_2m_max[i + 1],
                    humidity: openMeteoData.daily.relative_humidity_2m_max[i + 1],
                }));

                coreData = {
                    location: { city: resolvedLocation.city, country: resolvedLocation.country },
                    current: {
                        temp: openMeteoData.current.temperature_2m,
                        feelsLike: openMeteoData.current.apparent_temperature,
                        summary: '', // To be filled by AI
                        sunrise: new Date(openMeteoData.daily.sunrise[1]).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }),
                        sunset: new Date(openMeteoData.daily.sunset[1]).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }),
                        comparison: comparisonText,
                        clothingSuggestion: '', // To be filled by AI
                        humidity: openMeteoData.current.relative_humidity_2m,
                        windSpeed: openMeteoData.current.wind_speed_10m,
                    },
                    today: {
                        high: openMeteoData.daily.temperature_2m_max[1],
                        low: openMeteoData.daily.temperature_2m_min[1],
                        highHumidity: openMeteoData.daily.relative_humidity_2m_max[1],
                        lowHumidity: openMeteoData.daily.relative_humidity_2m_min[1],
                    },
                    forecast: fiveDayForecast,
                    hourly: hourlyData,
                    moonPhase: getMoonPhase(),
                    tideForecast: [],
                    regionalOutlook: [],
                };
            } catch(processingError) {
                console.error("Data Processing Error:", processingError);
                throw new Error('Received unexpected data from the weather service. Cannot display forecast.');
            }

            setWeatherData(coreData);
            setLastFetchTime(fetchTimestamp);
            setIsInitialLoading(false);
            
            // --- 4. START DECOUPLED, SEQUENTIAL/PARALLEL FETCHES FOR SLOW/AI DATA ---
            const fetchDecoupledData = async () => {
                // FIX: Separate Gemini calls from other parallel fetches to avoid rate-limiting.
                // Fetch non-Gemini dependent data first in parallel.
                const [tideResult, outlookResult] = await Promise.allSettled([
                    fetchTideData(resolvedLocation.lat, resolvedLocation.lon, resolvedLocation.timezone),
                    fetchPhilippineOutlookWithCache(),
                ]);

                // FIX: Process fast, non-AI data immediately to improve perceived performance.
                if (outlookResult.status === 'fulfilled') {
                    setWeatherData(prev => ({...prev, regionalOutlook: outlookResult.value}));
                } else {
                    console.error("Failed to fetch Philippine outlook data:", outlookResult.reason);
                    setWeatherData(prev => ({...prev, regionalOutlook: []})); 
                }
                setIsOutlookLoading(false);

                if (tideResult.status === 'fulfilled') {
                    const tideData = tideResult.value;
                    if (tideData && (tideData as any).type === 'inactive-feature') {
                        setTideError(tideData as any);
                        setWeatherData(prev => ({ ...prev, tideForecast: [] }));
                    } else {
                        try {
                            const flatTideData = tideData;
                            if (!flatTideData || !Array.isArray(flatTideData)) {
                                throw new Error("Tide data is missing or not an array.");
                            }
                            setWeatherData(prev => ({ ...prev, tideForecast: flatTideData }));
                            setTideError(null);
                        } catch (tideErr) {
                            console.error("Tide processing error:", tideErr);
                            setTideError({ type: 'parse', message: "Could not process tide forecast data." });
                            setWeatherData(prev => ({ ...prev, tideForecast: [] }));
                        }
                    }
                } else {
                    console.error("Failed to fetch tide data:", tideResult.reason);
                    setTideError({ type: 'generic', message: 'Tide forecast model is unavailable.' });
                }
                setIsTideLoading(false);

                // Now, fetch the Gemini-dependent data sequentially to avoid rate-limit errors.
                const aiResult = await fetchAiWeatherData(resolvedLocation).then(
                    value => ({ status: 'fulfilled', value } as const),
                    reason => ({ status: 'rejected', reason } as const)
                );

                const suspensionResult = await fetchSuspensionData(resolvedLocation).then(
                    value => ({ status: 'fulfilled', value } as const),
                    reason => ({ status: 'rejected', reason } as const)
                );

                // Process AI Weather Result
                if (aiResult.status === 'fulfilled') {
                    try {
                        const aiData = aiResult.value;
                        if (!aiData.summary || !aiData.clothingSuggestion) {
                            throw new Error("AI weather data is missing required fields.");
                        }
                        setWeatherData(prev => ({ 
                            ...prev, 
                            current: {
                                ...prev.current,
                                summary: aiData.summary,
                                clothingSuggestion: aiData.clothingSuggestion,
                            }
                        }));
                        setAiDataError(null);
                    } catch (aiErr) {
                        console.error("AI weather processing error:", aiErr);
                        const err = { type: 'parse', message: "AI provided invalid weather data." };
                        setAiDataError(err);
                    }
                } else { // 'rejected'
                    const reason = aiResult.reason;
                    console.error("Failed to fetch AI weather data:", reason);
                    const err = (reason && typeof reason === 'object' && reason !== null) ? reason : { message: String(reason) };
                    const message = (err as any).message || (typeof err === 'object' ? JSON.stringify(err) : String(err));
                    const errorState = { type: (err as any).type || 'generic', message: `AI Weather: ${message}` };
                    setAiDataError(errorState);
                }
                
                // Process Suspension Status Result
                if (suspensionResult.status === 'fulfilled') {
                    setSuspensionStatus(suspensionResult.value);
                } else { // 'rejected'
                    const reason = suspensionResult.reason;
                    console.error("Failed to fetch suspension data:", reason);
                    const err = (reason && typeof reason === 'object' && reason !== null) ? reason : { message: String(reason) };
                    const type = (err as any).type || 'generic';
                    const message = (err as any).message || (typeof err === 'object' ? JSON.stringify(err) : String(err));
                    const errorState = {
                        active: false,
                        details: { type, message },
                        sourceUrl: null
                    };
                    setSuspensionStatus(errorState);
                }

                setIsAiDataLoading(false);
            };

            fetchDecoupledData();

        } catch (err) {
            console.error("A critical error occurred in fetchAllData:", err);
            let errorMessage = `Error: ${err.message}`;
            if (err.message.includes("Weather service responded")) {
                errorMessage = "Could not retrieve current weather forecast. The service may be temporarily down.";
            }
            setError(errorMessage);
            setIsInitialLoading(false);
            setIsTideLoading(false);
            setIsAiDataLoading(false);
            setIsOutlookLoading(false);
        }
    }, [
        setIsInitialLoading,
        setIsTideLoading,
        setIsAiDataLoading,
        setIsOutlookLoading,
        setError,
        setTideError,
        setAiDataError,
        setSevereWeatherAlert,
        setLoadingMessage,
        setCurrentLocation,
        setLocationCoords,
        setWeatherData,
        setLastFetchTime,
        setSuspensionStatus,
    ]);
    

    useEffect(() => {
        fetchAllData(currentLocation);
        const intervalId = setInterval(() => fetchAllData(currentLocation), 900000); // Auto-refresh every 15 minutes
        return () => clearInterval(intervalId);
    }, [currentLocation.displayName, fetchAllData]);

    const handleLocationChange = (newLocation) => {
        // This function now receives a complete, validated location object with coordinates.
        localStorage.setItem('userLocation', JSON.stringify(newLocation));
        setCurrentLocation(newLocation);
    };
    
    const handleManualRefresh = () => {
         fetchAllData(currentLocation);
    };

    if (isInitialLoading) return <LoadingScreen message={loadingMessage} />;
    if (error) return (
        <div className="error-container">
            <h3>An Error Occurred</h3>
            <p>{error}</p>
            <button onClick={handleManualRefresh}>Try Again</button>
        </div>
    );
    if (!weatherData) return null;
    
    const { location, current, today, forecast, moonPhase } = weatherData;
    const formattedDate = new Date().toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
    const lastUpdatedTime = lastFetchTime 
        ? `Updated: ${lastFetchTime.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })}`
        : 'Updating...';
        
    return (
        <div className="dashboard">
            <LocationModal isOpen={isLocationModalOpen} onClose={() => setIsLocationModalOpen(false)} onLocationChange={handleLocationChange} />
            <HourlyForecastModal isOpen={isHourlyModalOpen} onClose={() => setIsHourlyModalOpen(false)} data={weatherData.hourly} />
            <AlertModal isOpen={isAlertModalOpen} onClose={() => setIsAlertModalOpen(false)} lat={locationCoords.lat} lon={locationCoords.lon} />
            <EarthquakeModal 
                isOpen={isEarthquakeModalOpen} 
                onClose={() => setIsEarthquakeModalOpen(false)}
                data={earthquakes}
                isLoading={isEarthquakeLoading}
                error={earthquakeError}
                loadData={loadEarthquakeData}
            />

            <header className="top-section">
                <div className="header-main">
                    <div className="location-header">
                        <h2>Today in {currentLocation.displayName.split(',')[0].trim()}</h2>
                        <button className="edit-btn" onClick={() => setIsLocationModalOpen(true)} aria-label="Change location" title="Change Location">
                            <Icon name="edit" />
                        </button>
                    </div>
                    <div className="header-actions">
                        <button 
                            className={`weather-alert-btn ${severeWeatherAlert ? 'alert-active' : 'all-clear'}`}
                            onClick={() => setIsAlertModalOpen(true)}
                            aria-label="Show weather radar"
                            title={severeWeatherAlert ? "Weather Alert Detected. Click for live radar." : "No active weather alerts"}
                        >
                            <Icon name="thunderstorm" />
                        </button>
                        <button 
                            className={`earthquake-btn ${significantEarthquakeAlert ? 'alert-active' : 'all-clear'}`}
                            onClick={() => setIsEarthquakeModalOpen(true)} 
                            aria-label="Show earthquake info" 
                            title={significantEarthquakeAlert ? "Significant Earthquake Detected. Click for details." : "No recent seismic alerts in the Philippines"}
                        >
                            <Icon name="earthquake" />
                        </button>
                        <DarkModeToggle theme={theme} toggleTheme={toggleTheme} />
                    </div>
                </div>
                
                <div className="alert-stack">
                    <ClassSuspensionAlert 
                        isLoading={isAiDataLoading} 
                        status={suspensionStatus}
                    />
                    <WeatherAlertBar alertData={severeWeatherAlert} />
                    <EarthquakeAlert alertData={significantEarthquakeAlert} error={earthquakeAlertError} />
                </div>
                
                <div className="current-temp">
                    <h1>{Math.round(current?.temp ?? 0)}°</h1>
                    <div className="current-humidity" title="Current Humidity">
                        <Icon name="humidity" />
                        <span>{current?.humidity ?? 0}%</span>
                    </div>
                </div>
                <div className="weather-details">
                    <div className="date-sun-group">
                        <span className="date-info">{formattedDate} &middot; {current?.comparison}</span>
                        <div className="sun-times">
                            <span className="sun-time-item" title="Sunrise"><Icon name="sunrise" /> ↑{'   '}{current?.sunrise}</span>
                            <span className="sun-time-item" title="Sunset"><Icon name="sunset" /> ↓{'   '}{current?.sunset}</span>
                        </div>
                    </div>
                    <span className="feels-like">Feels like {Math.round(current?.feelsLike ?? 0)}°</span>
                </div>
                <div className="summary">
                   {isAiDataLoading ? (
                        <LoadingPlaceholder text="Generating summary..." />
                    ) : aiDataError ? (
                        <div className="inline-error">{aiDataError.message}</div>
                    ) : (
                        <p>{current?.summary}</p>
                    )}
                </div>
                <div className="clothing-suggestion">
                    {isAiDataLoading ? (
                        <LoadingPlaceholder text="Thinking of an outfit..." />
                     ) : aiDataError ? (
                        <div className="inline-error">Outfit suggestion unavailable.</div>
                     ) : (
                        <div className="pill" title="Clothing Suggestion">
                            <Icon name="shirt" /> {current?.clothingSuggestion}
                        </div>
                    )}
                </div>
            </header>

            <main className="main-grid">
                <section className="grid-cell">
                    <div className="cell-header">
                        <h2 className="cell-title">Today's High/Low</h2>
                        <button className="btn-hourly" onClick={() => setIsHourlyModalOpen(true)}>Hourly</button>
                    </div>
                    <div className="today-metrics">
                        <div className="metric-item is-temp">
                            <span className="temp-value">{Math.round(today?.high ?? 0)}°</span>
                            <span className="temp-label">HIGH</span>
                        </div>
                        <div className="metric-item is-temp">
                             <span className="temp-value">{Math.round(today?.low ?? 0)}°</span>
                             <span className="temp-label">LOW</span>
                        </div>
                        <div className="metric-item is-humidity">
                            <span className="temp-value">{today?.highHumidity ?? 0}%</span>
                            <span className="temp-label">HIGH HUM.</span>
                        </div>
                        <div className="metric-item is-humidity">
                            <span className="temp-value">{today?.lowHumidity ?? 0}%</span>
                            <span className="temp-label">LOW HUM.</span>
                        </div>
                    </div>
                </section>
                <section className="grid-cell">
                    <div className="forecast-graph-wrapper">
                        <ForecastGraph data={forecast} />
                    </div>
                    <div className="forecast-list">
                        {forecast?.map(day => (
                            <div key={day.day} className="forecast-day">
                                <span title={day.description}><Icon name={getWeatherIcon(day.weatherCode)} /> {Math.round(day.temp)}°</span>
                                <span className="forecast-humidity">{day.humidity ?? 0}%</span>
                                <span className="forecast-date">{day.day}</span>
                            </div>
                        ))}
                    </div>
                </section>
                <section className="grid-cell details-cell">
                     <TideTable data={weatherData.tideForecast} moonPhase={moonPhase} isLoading={isTideLoading} error={tideError} currentTime={currentTime} />
                </section>
            </main>
            
            <section className="comparison-section">
                <h2 className="cell-title">Regional Outlook</h2>
                 {isOutlookLoading ? (
                    <div className="comparison-loading">
                         <LoadingPlaceholder text="Discovering regional cities..." className="comparison-placeholder"/>
                    </div>
                ) : weatherData.regionalOutlook && weatherData.regionalOutlook.length > 0 ? (
                    <div className="comparison-cities-list">
                        {weatherData.regionalOutlook
                            .filter(city => city.name.toLowerCase().replace(' city', '') !== currentLocation.city.toLowerCase().replace(' city', ''))
                            .map(city => (
                            <div key={city.name} className="comparison-city-item">
                                <span className="city-name">{city.name}</span>
                                <div title={city.condition}>
                                    <Icon name={getIconFromConditionString(city.condition)} />
                                </div>
                                <span className="city-temp">{Math.round(city.temp)}°</span>
                            </div>
                        ))}
                    </div>
                ) : (
                     <div className="comparison-none">No regional data available.</div>
                )}
            </section>

            <NewsTicker items={newsItems} breakingItem={breakingNews} />
            
            <footer className="footer">
                <div className="footer-details">
                    <div className="data-row" title="Last Update Time"><Icon name="history" /> {lastUpdatedTime}</div>
                </div>
                <button className="refresh-btn" onClick={handleManualRefresh} aria-label="Refresh weather data" title="Refresh Data">
                    <Icon name="refresh" />
                    <span>{currentTime.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })}</span>
                </button>
            </footer>
        </div>
    );
};

const container = document.getElementById('root');
const root = createRoot(container!);
root.render(<App />);