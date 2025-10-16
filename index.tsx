import React, { useState, useEffect, useMemo, useCallback, useRef, useLayoutEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { GoogleGenAI, Type } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

// --- Caching Layer for API Responses ---
const geminiCache = new Map();
const suspensionCache = new Map();


// --- Helper to identify rate limit errors from various APIs ---
const isRateLimitError = (error) => {
    if (!error || !error.message) return false;
    const msg = error.message.toLowerCase();
    // Check for common rate limit phrases from different APIs
    return msg.includes('rate limit') || msg.includes('resource has been exhausted') || msg.includes('429') || msg.includes('resource_exhausted');
};

// --- Rate Limiter & Backoff Wrapper for Gemini API ---
let lastGeminiApiCallTimestamp = 0;
const MIN_GEMINI_INTERVAL = 4000; // 4 seconds to stay well under 15 RPM for gemini-flash

const generateContentWithRateLimit = async (params, retries = 3, backoff = 1000) => {
    const now = Date.now();
    const timeSinceLastCall = now - lastGeminiApiCallTimestamp;

    if (timeSinceLastCall < MIN_GEMINI_INTERVAL) {
        const delay = MIN_GEMINI_INTERVAL - timeSinceLastCall;
        console.log(`Rate limiting active. Delaying next Gemini API call by ${delay}ms.`);
        await new Promise(resolve => setTimeout(resolve, delay));
    }

    try {
        lastGeminiApiCallTimestamp = Date.now();
        const result = await ai.models.generateContent(params);
        if (!result || !result.text) {
             throw new Error("Received empty response from Gemini.");
        }
        return result;
    } catch (error) {
        if (isRateLimitError(error) && retries > 0) {
            console.warn(`Gemini API rate limit hit. Retrying in ${backoff}ms... (${retries} retries left)`);
            await new Promise(resolve => setTimeout(resolve, backoff));
            // Don't apply the MIN_INTERVAL delay on retries, the backoff serves that purpose.
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
    'earthquake', 'typhoon', 'bongbong', 'marcos', 'inflation', 'flash flood',
    'alert level', 'gunman', 'fire', 'confirmed', 'official', 'suspends',
    'probe', 'investigation', 'crisis'
];
const NEWS_RSS_FEEDS = [
    'https://newsinfo.inquirer.net/category/latest-stories/feed/',
    'https://newsinfo.inquirer.net/category/metro/feed/'
];
const PROXY_URL = 'https://corsproxy.io/?';


const fetchAndProcessNews = async () => {
    const feedPromises = NEWS_RSS_FEEDS.map(feedUrl =>
        fetchWithRetry(`${PROXY_URL}${encodeURIComponent(feedUrl)}`, undefined)
        .then(response => {
            return response.text();
        })
        .catch(error => {
            console.error(`Failed to fetch news feed from ${feedUrl}:`, error);
            return null; // Return null on failure
        })
    );

    const feedResults = await Promise.all(feedPromises);

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

        xmlDoc.querySelectorAll('item').forEach(item => {
            const guid = item.querySelector('guid')?.textContent || item.querySelector('link')?.textContent;
            if (guid && !allItems.has(guid)) {
                const pubDateText = item.querySelector('pubDate')?.textContent;
                allItems.set(guid, {
                    title: item.querySelector('title')?.textContent || 'No title',
                    pubDate: pubDateText ? new Date(pubDateText) : new Date(),
                    guid: guid
                });
            }
        });
    });

    const sortedItems = Array.from(allItems.values()).sort((a, b) => b.pubDate.getTime() - a.pubDate.getTime());

    let breakingItem = null;
    const now = new Date();
    // 5 minutes ago - Tighter window for more immediate "breaking" news
    const recencyThreshold = now.getTime() - (5 * 60 * 1000);

    const potentialBreaking = sortedItems.find(item => {
        if (item.pubDate.getTime() < recencyThreshold) {
            return false; // Too old
        }
        const titleLower = item.title.toLowerCase();
        return BREAKING_NEWS_KEYWORDS.some(keyword => titleLower.includes(keyword));
    });

    if (potentialBreaking) {
        breakingItem = potentialBreaking;
    }

    const regularItems = sortedItems.filter(item => item.guid !== breakingItem?.guid);

    return { breakingItem, regularItems };
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

const TideTable = ({ data, moonPhase, isLoading, error }) => {
    const upcomingEvents = useMemo(() => {
        if (!data || data.length === 0) return [];
        
        const now = new Date();

        const allEvents = data.flatMap(day => {
            return day.events.map(event => {
                const eventDate = event.time; // event.time is now a Date object
                
                return { 
                    ...event, 
                    fullDate: eventDate, 
                    day: day.day,
                    time: eventDate.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }) 
                };
            });
        });
        
        return allEvents.filter(event => event.fullDate > now).slice(0, 4);
    }, [data]);

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
                <div className="tide-list-unavailable">
                    <Icon name="tide" />
                    <span>{error}</span>
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
    const [input, setInput] = useState('');
    const [suggestions, setSuggestions] = useState([]);
    const [isSuggesting, setIsSuggesting] = useState(false);
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [selectedLocation, setSelectedLocation] = useState(null);
    const hasSelectedSuggestion = useRef(false);

    const fetchSuggestions = useCallback(async (query) => {
        setIsSuggesting(true);
        setSuggestions([]);

        const prompt = `
            As a Philippine Geocoding Assistant, your primary function is to resolve user-provided Philippine locality names into precise geographic coordinates.
            When a user provides a single location keyword, generate a structured list of possible matches, each with its corresponding latitude and longitude.
            Constraints:
            - NO ZIP CODES.
            - The final output must be a clean Markdown table. NO introductory text.
            - The table columns must be in this exact order: Barangay/Locality, City/Municipality, Province/Region, Coordinates.
            - The 'Coordinates' column must contain the latitude and longitude as a single string, formatted as "lat,lon" (e.g., "14.5995,120.9842").
            - For locations in the National Capital Region (NCR), list the City/Municipality and use "NCR" in the Province/Region column.
            - For a common term, provide at least three geographically distinct results if possible.
            User Query: "${query}"
            Generate the Markdown table now.
        `;

        try {
            const result = await generateContentWithRateLimit({
                model: "gemini-2.5-flash",
                contents: prompt,
            });

            const markdownText = result.text.trim();
            const lines = markdownText.split('\n');

            if (lines.length < 3) { // Header, separator, and at least one data row
                setSuggestions([]);
                return;
            }

            const parsedSuggestions = lines.slice(2).map((line, index) => {
                const columns = line.split('|').map(c => c.trim()).filter(Boolean);
                if (columns.length === 4) { // Expecting 4 columns now
                    const [latStr, lonStr] = columns[3].split(',').map(s => s.trim());
                    const latitude = parseFloat(latStr);
                    const longitude = parseFloat(lonStr);

                    // Validate that we got actual numbers
                    if (!isNaN(latitude) && !isNaN(longitude)) {
                         return {
                            id: `${query}-${index}`,
                            locality: columns[0],
                            city: columns[1],
                            province: columns[2],
                            latitude: latitude,
                            longitude: longitude
                        };
                    }
                }
                return null;
            }).filter(Boolean);

            setSuggestions(parsedSuggestions);

        } catch (error) {
            console.error("Failed to fetch AI suggestions:", error);
            setSuggestions([]);
        } finally {
            setIsSuggesting(false);
        }
    }, []);

    useEffect(() => {
        if (hasSelectedSuggestion.current) {
            hasSelectedSuggestion.current = false;
            return;
        }

        const handler = setTimeout(() => {
            if (input.length > 2) {
                fetchSuggestions(input);
            } else {
                setSuggestions([]);
            }
        }, 600);
        return () => clearTimeout(handler);
    }, [input, fetchSuggestions]);

    const handleSelect = (suggestion) => {
        const displayText = [suggestion.locality, suggestion.city, suggestion.province].filter(Boolean).join(', ');

        hasSelectedSuggestion.current = true;
        setInput(displayText);
        setSelectedLocation(suggestion);
        setSuggestions([]);
    };

    const handleSubmit = async () => {
        setIsSubmitting(true);
        try {
            // Optimal Path: Use pre-fetched coordinates from AI suggestion.
            if (selectedLocation && selectedLocation.latitude && selectedLocation.longitude) {
                // We have everything we need, no need to call geocoding API.
                onLocationChange({
                    displayName: [selectedLocation.locality, selectedLocation.city, selectedLocation.province].filter(Boolean).join(', '),
                    city: selectedLocation.city,
                    admin1: selectedLocation.province,
                    admin2: selectedLocation.locality, // Best guess mapping
                    country: "Philippines",
                    latitude: selectedLocation.latitude,
                    longitude: selectedLocation.longitude,
                });
            } else {
                // Fallback Path: User typed text or suggestion had no coords. Geocode the text input.
                const searchText = input.trim();
                if (searchText) {
                     const geoApiUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(searchText)}&count=1&format=json&country=PH`;
                     const geoResponse = await fetchWithRetry(geoApiUrl, undefined);
                     const geoData = await geoResponse.json();

                     if (geoData.results && geoData.results.length > 0) {
                        const result = geoData.results[0];
                        onLocationChange({
                            displayName: [result.name, result.admin1, result.country].filter(Boolean).join(', '),
                            city: result.name,
                            admin1: result.admin1,
                            admin2: result.admin2,
                            country: result.country,
                            latitude: result.latitude,
                            longitude: result.longitude,
                        });
                    } else {
                        // Pass raw string if geocoding fails, so an error can be shown.
                        onLocationChange(searchText);
                    }
                }
            }
        } catch (error) {
            console.error("Error during location submission:", error);
            onLocationChange(input.trim());
        } finally {
            setIsSubmitting(false);
            onClose();
        }
    };

    if (!isOpen) return null;

    return (
        <div className="modal-overlay" onClick={onClose}>
            <div className="modal-content" onClick={e => e.stopPropagation()}>
                <h3>Change Location</h3>
                <div className="search-container">
                    <input
                        type="text"
                        value={input}
                        onChange={(e) => {
                           setInput(e.target.value);
                           setSelectedLocation(null);
                        }}
                        placeholder="e.g., Longos, Malabon"
                        autoFocus
                    />
                    {isSuggesting ? (
                        <div className="suggestions-list"><li className="suggestion-status">Searching...</li></div>
                    ) : suggestions.length > 0 && (
                        <ul className="suggestions-list">
                            {suggestions.map((s) => {
                                const displayText = [s.locality, s.city, s.province].filter(Boolean).join(', ');
                                return <li key={s.id} onClick={() => handleSelect(s)}>{displayText}</li>;
                            })}
                        </ul>
                    )}
                </div>
                <div className="modal-actions">
                    <button onClick={onClose} className="btn-secondary">Cancel</button>
                    <button onClick={handleSubmit} className="btn-primary" disabled={isSubmitting}>
                        {isSubmitting ? 'Updating...' : 'Update'}
                    </button>
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

// --- New Earthquake Feature Components ---
const fetchEarthquakeData = async (periodInDays = 1) => {
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(endDate.getDate() - periodInDays);

    const formatISODate = (date) => date.toISOString().split('.')[0];

    const params = new URLSearchParams({
        format: 'geojson',
        starttime: formatISODate(startDate),
        endtime: formatISODate(endDate),
        minlatitude: '4',
        maxlatitude: '20',
        minlongitude: '116',
        maxlongitude: '128',
        minmagnitude: '4.5',
        orderby: 'time',
        limit: '10', // Get the 10 most recent significant events
    });

    const url = `https://earthquake.usgs.gov/fdsnws/event/1/query?${params}`;

    try {
        const response = await fetchWithRetry(url, undefined);
        if (!response.ok) {
            throw new Error(`USGS API responded with status ${response.status}`);
        }
        const data = await response.json();
        return data.features || [];
    } catch (error) {
        console.error("Failed to fetch earthquake data:", error);
        throw error; // Propagate the error to be handled by the caller
    }
};

const earthquakeLocationCache = new Map();

const getRefinedEarthquakeLocation = async (feature) => {
    if (!feature?.properties?.place) return "Unknown location";

    const originalPlace = feature.properties.place;
    const { mag } = feature.properties;
    const { id } = feature;

    if (earthquakeLocationCache.has(id)) {
        return earthquakeLocationCache.get(id);
    }

    // Avoid unnecessary API calls for non-PH locations or already detailed strings
    if (!originalPlace.toLowerCase().includes('philippines') || originalPlace.split(',').length > 2) {
        earthquakeLocationCache.set(id, originalPlace);
        return originalPlace;
    }

    const prompt = `
        Analyze the following raw USGS earthquake report. Using Google Search, identify the specific Philippine province for the location mentioned.
        Then, reformat the location string into this exact format: "[Distance] [Direction] of [Municipality], [Province]".

        - If the search does not yield a clear province, or if the original location is already specific or a general region (e.g., "Mindanao, Philippines"), return the original text.
        - Your final output MUST BE ONLY the refined location string. Do not include magnitude, depth, or any other text.

        Raw report: "M${mag?.toFixed(1)} located ${originalPlace}"
        
        Refined location string:
    `;

    try {
        const result = await generateContentWithRateLimit({
            model: "gemini-2.5-flash",
            contents: prompt,
            config: { tools: [{ googleSearch: {} }] }
        });

        const refinedPlace = result.text.trim();
        // A simple validation to prevent empty strings or model chatter from being displayed
        if (refinedPlace.length < 5) {
             throw new Error("Received an invalid refined location.");
        }

        earthquakeLocationCache.set(id, refinedPlace);
        return refinedPlace;
    } catch (error) {
        console.error(`Failed to refine location for "${originalPlace}". Returning original.`, error);
        // Cache the original on failure to prevent retrying a failing query
        earthquakeLocationCache.set(id, originalPlace);
        return originalPlace;
    }
};


const WeatherAlertBar = ({ alertData }) => {
    const [isShrunk, setIsShrunk] = useState(false);

    useEffect(() => {
        const timer = setTimeout(() => {
            setIsShrunk(!alertData);
        }, 50);

        return () => clearTimeout(timer);
    }, [alertData]);

    const alertClass = [
        'weather-alert-bar',
        !alertData ? 'all-clear' : 'alert-active',
        isShrunk ? 'shrunk' : ''
    ].filter(Boolean).join(' ');

    const alertText = alertData ? `${alertData.toUpperCase()} ALERT` : 'WEATHER STATUS: ALL CLEAR';
    const fullAlertText = alertData ? `Weather Alert: ${alertData}` : 'Weather Status: All Clear';

    return (
        <div className={alertClass}>
            {!alertData ? (
                <>
                    <Icon name="thunderstorm" />
                    <span>WEATHER STATUS: ALL CLEAR</span>
                </>
            ) : (
                <>
                    <Icon name="thunderstorm" />
                    <span className="alert-bar-text" title={fullAlertText}>{alertText}</span>
                </>
            )}
        </div>
    );
};

const EarthquakeAlert = ({ alertData }) => {
    const [isShrunk, setIsShrunk] = useState(false);

    useEffect(() => {
        const timer = setTimeout(() => {
            setIsShrunk(!alertData);
        }, 50);

        return () => clearTimeout(timer);
    }, [alertData]);

    const alertClass = [
        'earthquake-alert',
        !alertData ? 'all-clear' : 'alert-active',
        isShrunk ? 'shrunk' : ''
    ].filter(Boolean).join(' ');

    const alertText = alertData 
        ? `M${alertData.properties.mag.toFixed(1)} Earthquake detected in ${alertData.properties.place}` 
        : 'SEISMIC STATUS: ALL CLEAR';

    return (
        <div className={alertClass}>
            {!alertData ? (
                <>
                    <Icon name="earthquake" />
                    <span>SEISMIC STATUS: ALL CLEAR</span>
                </>
            ) : (
                <>
                    <Icon name="earthquake" />
                    <span className="alert-bar-text" title={alertText}>{alertText}</span>
                </>
            )}
        </div>
    );
};

const EarthquakeModal = ({ isOpen, onClose }) => {
    const [filter, setFilter] = useState('day'); // 'day' or 'month'
    const [earthquakes, setEarthquakes] = useState([]);
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState(null);

    useEffect(() => {
        if (isOpen) {
            const loadData = async () => {
                setIsLoading(true);
                setError(null);
                try {
                    const period = filter === 'day' ? 1 : 30;
                    const data = await fetchEarthquakeData(period);
                    
                    const refinedDataPromises = data.map(async eq => {
                        const refinedPlace = await getRefinedEarthquakeLocation(eq);
                        return { ...eq, properties: { ...eq.properties, place: refinedPlace } };
                    });
                    const refinedEarthquakes = await Promise.all(refinedDataPromises);
                    setEarthquakes(refinedEarthquakes);

                } catch (err) {
                    setError("Could not load seismic data. Please try again later.");
                } finally {
                    setIsLoading(false);
                }
            };
            loadData();
        }
    }, [isOpen, filter]);

    if (!isOpen) return null;

    const getMagClass = (mag) => {
        if (mag >= 6.0) return 'mag-high';
        if (mag >= 5.0) return 'mag-medium';
        return 'mag-low';
    };

    return (
        <div className="modal-overlay" onClick={onClose}>
            <div className="modal-content earthquake-modal-content" onClick={e => e.stopPropagation()}>
                <h3>Recent Earthquakes</h3>
                <div className="eq-filter-controls">
                    <button className={filter === 'day' ? 'active' : ''} onClick={() => setFilter('day')}>Past 24 Hours</button>
                    <button className={filter === 'month' ? 'active' : ''} onClick={() => setFilter('month')}>Past 30 Days</button>
                </div>
                <ul className="eq-list">
                    {isLoading ? (
                        <div className="eq-loading">Loading seismic data...</div>
                    ) : error ? (
                        <div className="eq-none">{error}</div>
                    ) : earthquakes.length > 0 ? (
                        earthquakes.map(eq => (
                            <li key={eq.id} className="eq-item">
                                <div className={`eq-magnitude ${getMagClass(eq.properties.mag)}`}>
                                    <span>M</span>{eq.properties.mag.toFixed(1)}
                                </div>
                                <div className="eq-info">
                                    <span className="eq-location">{eq.properties.place}</span>
                                    <span className="eq-details">
                                        Depth: {eq.geometry.coordinates[2].toFixed(1)} km &middot; {formatTimeAgo(eq.properties.time)}
                                    </span>
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

const NewsTicker = ({ items }) => {
    const [animationDuration, setAnimationDuration] = useState('90s');
    const contentRef = useRef(null);

    const hasContent = items && items.length > 0;
    const tickerContent = useMemo(() => items.map(item => item.title).join(' • '), [items]);

    useLayoutEffect(() => {
        if (contentRef.current) {
            const contentWidth = contentRef.current.offsetWidth / 2;
            const pixelsPerSecond = 50; 
            if (contentWidth > 0) {
                const duration = contentWidth / pixelsPerSecond;
                setAnimationDuration(`${duration.toFixed(2)}s`);
            } else {
                setAnimationDuration('0s');
            }
        }
    }, [tickerContent]);

    if (!hasContent) return null;

    return (
        <div className="news-ticker-container">
            <span className="news-ticker-label">LATEST NEWS</span>
            <div className="news-ticker-wrapper">
                <div
                    className="news-ticker-content"
                    key={tickerContent}
                    ref={contentRef}
                    style={{ animationDuration }}
                >
                    <span>{tickerContent}</span>
                    <span>{tickerContent}</span>
                </div>
            </div>
        </div>
    );
};

const BreakingNewsTicker = ({ item }) => {
    const [animationDuration, setAnimationDuration] = useState('30s');
    const contentRef = useRef(null);

    const tickerContent = item.title;

    useLayoutEffect(() => {
        if (contentRef.current) {
            // For the 'scroll-from-right' animation, the content travels a distance
            // equivalent to its own width to enter the screen, and its own width again
            // to exit, for a total of 2x its width.
            const contentWidth = contentRef.current.offsetWidth; // Use the FULL width of the element
            const pixelsPerSecond = 80; // Desired scroll speed

            if (contentWidth > 0) {
                // The animation's travel distance is from translateX(100%) to -translateX(100%), so 2 * contentWidth
                const totalDistance = contentWidth * 2;
                const duration = totalDistance / pixelsPerSecond;
                setAnimationDuration(`${duration.toFixed(2)}s`);
            } else {
                setAnimationDuration('0s');
            }
        }
    }, [tickerContent]);

    return (
        <div className="breaking-news-ticker">
            <span className="news-ticker-label">BREAKING NEWS</span>
            <div className="news-ticker-wrapper">
                <div
                    className="news-ticker-content"
                    key={tickerContent}
                    ref={contentRef}
                    style={{ animationDuration }}
                >
                    <span>{tickerContent}</span>
                    <span>{tickerContent}</span>
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
    
    // Check if the status represents an error state
    const isError = !status.active && (status.details.includes('Could not') || status.details.includes('Failed') || status.details.includes('Error') || status.details.includes('busy'));

    const alertClass = [
        'class-suspension-alert',
        isError ? 'error-state' : (status.active ? 'alert-active' : 'all-clear')
    ].join(' ');
    
    const TRUNCATE_LENGTH = 90;
    const isLongText = status.details.length > TRUNCATE_LENGTH;
    const alertText = isLongText ? `${status.details.substring(0, TRUNCATE_LENGTH)}...` : status.details;

    return (
        <>
            <SuspensionDetailsModal 
                isOpen={isDetailsModalOpen} 
                onClose={() => setIsDetailsModalOpen(false)} 
                details={status.details}
                sourceUrl={status.sourceUrl}
            />
            <div className={alertClass}>
                <span>{alertText}</span>
                {isLongText && !isError && (
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

const App = () => {
    const [weatherData, setWeatherData] = useState(null);
    const [comparisonCities, setComparisonCities] = useState([]);
    const [isComparisonLoading, setIsComparisonLoading] = useState(true);
    const [comparisonError, setComparisonError] = useState(null);
    const [newsItems, setNewsItems] = useState([]);
    const [breakingNews, setBreakingNews] = useState(null);
    const [isInitialLoading, setIsInitialLoading] = useState(true);
    const [isSummaryLoading, setIsSummaryLoading] = useState(true);
    const [isTideLoading, setIsTideLoading] = useState(true);
    const [loadingMessage, setLoadingMessage] = useState('Initializing...');
    const [error, setError] = useState(null);
    const [summaryError, setSummaryError] = useState(null);
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
    const [significantEarthquakeAlert, setSignificantEarthquakeAlert] = useState(null);
    const [severeWeatherAlert, setSevereWeatherAlert] = useState(null);
    const [locationCoords, setLocationCoords] = useState({ lat: null, lon: null });
    const [lastFetchTime, setLastFetchTime] = useState(null);
    const [suspensionStatus, setSuspensionStatus] = useState(null);
    const [isSuspensionLoading, setIsSuspensionLoading] = useState(true);
    const [theme, setTheme] = useState(() => {
        const savedTheme = localStorage.getItem('theme');
        const userPrefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
        return savedTheme || (userPrefersDark ? 'dark' : 'light');
    });

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

    // Dedicated effect for earthquake data fetching (every 5 mins)
    useEffect(() => {
        const checkEarthquakes = async () => {
            try {
                const recentQuakes = await fetchEarthquakeData(1); // Check last 24 hours
                if (recentQuakes.length > 0) {
                    const mostRecentQuake = recentQuakes[0];
                    const quakeTime = mostRecentQuake.properties.time;
                    const now = new Date().getTime();
                    const freshnessThreshold = 3600 * 1000; // 1-hour freshness threshold

                    if ((now - quakeTime) < freshnessThreshold) {
                        const refinedPlace = await getRefinedEarthquakeLocation(mostRecentQuake);
                        const refinedQuakeData = { 
                            ...mostRecentQuake, 
                            properties: { ...mostRecentQuake.properties, place: refinedPlace } 
                        };
                        setSignificantEarthquakeAlert(refinedQuakeData);
                    } else {
                        setSignificantEarthquakeAlert(null);
                    }
                } else {
                    setSignificantEarthquakeAlert(null);
                }
            } catch (error) {
                console.error("Failed to check for earthquakes:", error);
                setSignificantEarthquakeAlert(null); // Clear alert on error
            }
        };

        checkEarthquakes();
        const eqInterval = setInterval(checkEarthquakes, 300000); // 5 minutes

        return () => clearInterval(eqInterval);
    }, []);
    
    // Dedicated effect for class suspension checks
    useEffect(() => {
        if (!currentLocation.displayName) return;

        const fetchSuspensionStatus = async () => {
            setIsSuspensionLoading(true);
            setSuspensionStatus(null);
            const cityName = currentLocation.city || currentLocation.displayName.split(',')[0];
            const locationForPrompt = currentLocation.admin2 
                ? `${cityName}, ${currentLocation.admin2}` 
                : cityName;
            const currentDate = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

            const CACHE_TTL = 30 * 60 * 1000; // 30 minutes for suspension info
            const cachedStatus = suspensionCache.get(locationForPrompt);
            if (cachedStatus && (Date.now() - cachedStatus.timestamp < CACHE_TTL)) {
                console.log("Using cached suspension data for", locationForPrompt);
                setSuspensionStatus(cachedStatus.data);
                setIsSuspensionLoading(false);
                return;
            }

            try {
                 const prompt = `
                    Analyze official announcements for class suspensions ("Walang Pasok") in ${locationForPrompt}, Philippines for today, ${currentDate}.
                    Focus only on official government (PAGASA, DepEd) and major news sources.
                    Based on your findings, populate the fields in the provided JSON schema.
                    - If a suspension is confirmed, set "suspension_confirmed" to true, provide a brief summary in "details", and include the direct URL to the source announcement in "source_url".
                    - If no specific announcements are found, set "suspension_confirmed" to false, "details" to a confirmation message, and "source_url" to an empty string.
                `;
                
                const searchResult = await generateContentWithRateLimit({
                    model: "gemini-2.5-pro",
                    contents: prompt,
                    config: {
                        responseMimeType: "application/json",
                        responseSchema: {
                            type: Type.OBJECT,
                            properties: {
                                suspension_confirmed: { type: Type.BOOLEAN },
                                details: { type: Type.STRING },
                                source_url: { type: Type.STRING },
                            },
                            required: ["suspension_confirmed", "details", "source_url"],
                        },
                    },
                });

                let responseData;
                 try {
                    responseData = JSON.parse(searchResult.text);
                } catch (parseError) {
                    console.error("Failed to parse suspension status JSON:", parseError, "Response text:", searchResult.text);
                    throw new Error("AI provided a response in an unreadable format.");
                }

                let newStatus;
                if (typeof responseData.suspension_confirmed === 'boolean' && typeof responseData.details === 'string') {
                     newStatus = {
                        active: responseData.suspension_confirmed,
                        details: responseData.suspension_confirmed ? responseData.details : `No Class Suspension for ${cityName}.`,
                        sourceUrl: responseData.source_url || null,
                    };
                } else {
                    throw new Error("AI response was missing required fields.");
                }
                
                suspensionCache.set(locationForPrompt, { data: newStatus, timestamp: Date.now() });
                setSuspensionStatus(newStatus);

            } catch (error) {
                console.error("Error in fetchSuspensionStatus:", error);
                let errorMessage = `Could not check for announcements for ${cityName}.`;
                if (isRateLimitError(error)) {
                    errorMessage = `Suspension check is temporarily busy for ${cityName}.`;
                }
                setSuspensionStatus({
                    active: false,
                    details: errorMessage,
                    sourceUrl: null
                });
            } finally {
                setIsSuspensionLoading(false);
            }
        };

        fetchSuspensionStatus();

    }, [currentLocation.displayName, currentLocation.city, currentLocation.admin1, currentLocation.admin2, currentLocation.country]);

    const fetchAllData = useCallback(async (locationDetails) => {
        setIsInitialLoading(true);
        setIsTideLoading(true);
        setIsSummaryLoading(true);
        setIsComparisonLoading(true);
        setError(null);
        setSummaryError(null);
        setTideError(null);
        setComparisonError(null);
        setSevereWeatherAlert(null);
        const fetchTimestamp = new Date();
        
        const fetchGeminiEnhancements = async (resolvedLoc, openMeteo) => {
            const cacheKey = `${resolvedLoc.lat.toFixed(2)}-${resolvedLoc.lon.toFixed(2)}`;
            const CACHE_TTL = 10 * 60 * 1000; // 10 minutes
            const cached = geminiCache.get(cacheKey);

            if (cached && (Date.now() - cached.timestamp < CACHE_TTL)) {
                console.log("Using cached Gemini data for", resolvedLoc.displayName);
                const cachedData = cached.data;
                 // Manually process each part from cache to ensure UI consistency
                try {
                    if (!cachedData.summary) throw new Error("Cached summary is invalid.");
                    setWeatherData(prev => ({...prev, current: { ...prev.current, summary: cachedData.summary, clothingSuggestion: cachedData.clothingSuggestion }}));
                    setSummaryError(null);
                } catch { setSummaryError("Cached summary was invalid."); }

                try {
                    if (!cachedData.tideForecast) throw new Error("Cached tide data is invalid.");
                    const now = new Date();
                    const parsedEvents = cachedData.tideForecast
                        .map(event => ({...event, time: new Date(event.time)}))
                        .filter(event => !isNaN(event.time.getTime()) && event.time > now)
                        .sort((a,b) => a.time.getTime() - b.time.getTime());

                     const tideDataByDay = parsedEvents.reduce((acc, event) => {
                        const dateKey = event.time.toISOString().split('T')[0];
                        if (!acc[dateKey]) {
                            acc[dateKey] = {
                                day: event.time.toLocaleDateString('en-US', { weekday: 'short' }).toUpperCase(),
                                date: event.time.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
                                events: []
                            };
                        }
                        acc[dateKey].events.push(event);
                        return acc;
                    }, {});
                    setWeatherData(prev => ({ ...prev, tideForecast: Object.values(tideDataByDay) }));
                    setTideError(null);
                } catch { setTideError("Cached tide data was invalid."); }

                try {
                     if (!cachedData.regionalOutlook) throw new Error("Cached regional data is invalid.");
                    setComparisonCities(cachedData.regionalOutlook);
                    setComparisonError(null);
                } catch { setComparisonError("Cached regional data was invalid."); }
                
                setIsSummaryLoading(false);
                setIsTideLoading(false);
                setIsComparisonLoading(false);
                return;
            }

            try {
                 const geminiPrompt = `
                    Analyze the provided weather data for ${resolvedLoc.displayName}.
                    Your task is to act as an API. Use Google Search to find tide times.
                    Your response must be ONLY a single, valid JSON object. Do not include markdown formatting, introductory text, or any other content outside of the JSON structure.

                    The JSON object must adhere to this exact schema:
                    {
                        "summary": "string",
                        "clothingSuggestion": "string",
                        "tideForecast": [
                            {"time": "string (ISO 8601 format, e.g., 'YYYY-MM-DDTHH:MM:SSZ')", "height": "number (in meters)", "type": "string ('High' or 'Low')"}
                        ],
                        "regionalOutlook": [
                            {"name": "string (City Name)", "temp": "number (Celsius)", "condition": "string"}
                        ]
                    }

                    Guidelines:
                    - Summary: A concise, one-sentence weather narrative for the day.
                    - Clothing Suggestion: A brief, practical outfit recommendation based on the weather.
                    - Tide Forecast: Find tide times for the nearest major port to ${resolvedLoc.displayName} for the next 24 hours. Provide at least the next four high/low tide events. If no data is found, return an empty array.
                    - Regional Outlook: Provide the current temperature and a one-word weather condition (e.g., 'Sunny', 'Cloudy', 'Rain') for three other major cities in the same region or island group as ${resolvedLoc.displayName}. If no data is found, return an empty array.

                    Weather Data: ${JSON.stringify(openMeteo)}
                `;
                
                const geminiResponse = await generateContentWithRateLimit({
                    model: "gemini-2.5-pro", // Using a more powerful model for better search and JSON formatting.
                    contents: geminiPrompt,
                    config: {
                        tools: [{ googleSearch: {} }], // Can't be used with responseMimeType/responseSchema
                    },
                });

                let geminiData;
                try {
                    // Clean the response text: remove markdown backticks and trim whitespace
                    let cleanedText = geminiResponse.text.trim();
                    if (cleanedText.startsWith("```json")) {
                        cleanedText = cleanedText.substring(7);
                    }
                    if (cleanedText.startsWith("```")) {
                        cleanedText = cleanedText.substring(3);
                    }
                    if (cleanedText.endsWith("```")) {
                        cleanedText = cleanedText.slice(0, -3);
                    }
                    geminiData = JSON.parse(cleanedText);
                } catch (parseError) {
                    console.error("Failed to parse AI response as JSON:", parseError, "Response text:", geminiResponse.text);
                    throw new Error("The AI provided a response in an unreadable format.");
                }

                // Process Summary & Clothing
                try {
                    if (!geminiData.summary || typeof geminiData.summary !== 'string' || geminiData.summary.trim() === '') {
                        throw new Error("Summary text is missing or invalid in the AI response.");
                    }
                    const cleanSummary = geminiData.summary.replace(/\s{2,}/g, ' ').trim();
                    const cleanClothingSuggestion = geminiData.clothingSuggestion || 'Light, comfortable clothing is a good choice.';
                    setWeatherData(prev => ({ ...prev, current: { ...prev.current, summary: cleanSummary, clothingSuggestion: cleanClothingSuggestion }}));
                    setSummaryError(null);
                } catch (summaryErr) {
                    console.error("Summary processing error:", summaryErr);
                    setSummaryError("AI failed to create a valid summary.");
                    setWeatherData(prev => ({ ...prev, current: { ...prev.current, summary: "", clothingSuggestion: "" }}));
                }

                // Process Tide Forecast
                try {
                    if (!geminiData.tideForecast || !Array.isArray(geminiData.tideForecast)) {
                        throw new Error("Tide forecast data is missing or not an array.");
                    }
                    const now = new Date();
                    const parsedEvents = geminiData.tideForecast.map(event => {
                        if (!event || typeof event.time !== 'string' || typeof event.height !== 'number' || typeof event.type !== 'string') return null;
                        const eventDate = new Date(event.time);
                        if (isNaN(eventDate.getTime())) return null;
                        return { ...event, time: eventDate };
                    }).filter(event => event && event.time > now).sort((a, b) => a.time.getTime() - b.time.getTime());

                    const tideDataByDay = parsedEvents.reduce((acc, event) => {
                        const dateKey = event.time.toISOString().split('T')[0];
                        if (!acc[dateKey]) {
                            acc[dateKey] = { day: event.time.toLocaleDateString('en-US', { weekday: 'short' }).toUpperCase(), date: event.time.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }), events: [] };
                        }
                        acc[dateKey].events.push(event);
                        return acc;
                    }, {});
                    setWeatherData(prev => ({ ...prev, tideForecast: Object.values(tideDataByDay) }));
                    setTideError(null);
                } catch (tideErr) {
                    console.error("Tide processing error:", tideErr);
                    setTideError("AI provided invalid tide forecast data.");
                    setWeatherData(prev => ({ ...prev, tideForecast: [] }));
                }

                // Process Regional Outlook
                try {
                    if (!geminiData.regionalOutlook || !Array.isArray(geminiData.regionalOutlook)) {
                        throw new Error("Regional outlook data is missing or not an array.");
                    }
                    setComparisonCities(geminiData.regionalOutlook);
                    setComparisonError(null);
                } catch (regionalErr) {
                    console.error("Regional outlook processing error:", regionalErr);
                    setComparisonError("AI provided invalid regional data.");
                    setComparisonCities([]);
                }
                
                geminiCache.set(cacheKey, { data: geminiData, timestamp: Date.now() });

            } catch (err) {
                console.error("Failed to fetch or process Gemini enhancements:", err);
                let errorMessage;
                if (isRateLimitError(err)) {
                    errorMessage = "AI features are busy due to high traffic.";
                } else if (err.message.includes("unreadable format")) {
                    errorMessage = "AI response was malformed.";
                } else {
                    errorMessage = "Could not contact the AI service.";
                }
                setSummaryError(errorMessage);
                setTideError(errorMessage);
                setComparisonError(errorMessage);
                setWeatherData(prev => ({ ...prev, current: { ...prev.current, summary: "", clothingSuggestion: "" }, tideForecast: [] }));
                setComparisonCities([]);
            } finally {
                setIsSummaryLoading(false);
                setIsTideLoading(false);
                setIsComparisonLoading(false);
            }
        };

        try {
            // --- 1. Geocoding ---
            let resolvedLocation;
            const locationName = locationDetails.displayName;
            setLoadingMessage(`Resolving location for ${locationName}...`);

            if (locationDetails.lat && locationDetails.lon && locationDetails.city) {
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
            let openMeteoData;
            try {
                setLoadingMessage('Fetching standard weather forecasts...');
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
                openMeteoData = await weatherResponse.json();

                if (openMeteoData.error) {
                    throw new Error(`Weather service responded with an error: ${openMeteoData.reason}`);
                }
            } catch (weatherError) {
                console.error("Weather API Error:", weatherError);
                throw new Error(weatherError.message || 'The weather service is currently unavailable. Please try again later.');
            }

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
                        summary: "",
                        sunrise: new Date(openMeteoData.daily.sunrise[1]).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }),
                        sunset: new Date(openMeteoData.daily.sunset[1]).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }),
                        comparison: comparisonText,
                        clothingSuggestion: "",
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
                };
            } catch(processingError) {
                console.error("Data Processing Error:", processingError);
                throw new Error('Received unexpected data from the weather service. Cannot display forecast.');
            }

            setWeatherData(coreData);
            setLastFetchTime(fetchTimestamp);
            setIsInitialLoading(false);
            
            fetchGeminiEnhancements(resolvedLocation, openMeteoData);

        } catch (err) {
            console.error("A critical error occurred in fetchAllData:", err);
            setError(`Error: ${err.message}`);
            setIsInitialLoading(false);
            setIsSummaryLoading(false);
            setIsTideLoading(false);
            setIsComparisonLoading(false);
        }
    }, []);
    

    useEffect(() => {
        fetchAllData(currentLocation);
        const intervalId = setInterval(() => fetchAllData(currentLocation), 900000); // Auto-refresh every 15 minutes
        return () => clearInterval(intervalId);
    }, [currentLocation.displayName, fetchAllData]);

    const handleLocationChange = (newLocation) => {
        if (typeof newLocation === 'string') {
            // Manual input: Reset detailed fields and let fetchAllData resolve them.
            setCurrentLocation({
                displayName: newLocation,
                city: null, admin1: null, admin2: null, country: null, lat: null, lon: null
            });
        } else {
            // Selection from suggestions: We have all the data.
            setCurrentLocation({
                displayName: newLocation.displayName,
                city: newLocation.city,
                admin1: newLocation.admin1,
                admin2: newLocation.admin2,
                country: newLocation.country,
                lat: newLocation.latitude,
                lon: newLocation.longitude,
            });
        }
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
            <EarthquakeModal isOpen={isEarthquakeModalOpen} onClose={() => setIsEarthquakeModalOpen(false)} />

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
                
                <ClassSuspensionAlert 
                    isLoading={isSuspensionLoading} 
                    status={suspensionStatus}
                />
                <WeatherAlertBar alertData={severeWeatherAlert} />
                <EarthquakeAlert alertData={significantEarthquakeAlert} />
                
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
                   {isSummaryLoading ? (
                        <LoadingPlaceholder text="Generating summary..." />
                    ) : summaryError ? (
                        <div className="inline-error">{summaryError}</div>
                    ) : (
                        <p>{current?.summary}</p>
                    )}
                </div>
                <div className="clothing-suggestion">
                    {isSummaryLoading ? (
                        <LoadingPlaceholder text="Thinking of an outfit..." />
                     ) : summaryError ? (
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
                     <TideTable data={weatherData.tideForecast} moonPhase={moonPhase} isLoading={isTideLoading} error={tideError} />
                </section>
            </main>
            
            <section className="comparison-section">
                <h2 className="cell-title">Regional Outlook</h2>
                 {isComparisonLoading ? (
                    <div className="comparison-loading">
                         <LoadingPlaceholder text="Discovering regional cities..." className="comparison-placeholder"/>
                    </div>
                ) : comparisonError ? (
                    <div className="inline-error comparison-error">{comparisonError}</div>
                ) : comparisonCities.length > 0 ? (
                    <div className="comparison-cities-list">
                        {comparisonCities.map(city => (
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

            <NewsTicker items={newsItems} />
            {breakingNews && <BreakingNewsTicker item={breakingNews} />}
            
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