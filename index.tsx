import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { createRoot } from 'react-dom/client';

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

const ForecastGraph = ({ data }) => {
    const { path, dots } = useMemo(() => {
        if (!data || data.length === 0) return { path: '', dots: [] };
        const validData = data.filter(d => typeof d?.temp === 'number' && d?.day);
        if (validData.length < 2) return { path: '', dots: [] };

        const width = 250, height = 40, padding = 5;
        const temps = validData.map(d => d.temp);
        const minTemp = Math.min(...temps), maxTemp = Math.max(...temps);
        const tempRange = maxTemp - minTemp;
        const getX = i => (i / (validData.length - 1)) * (width - padding * 2) + padding;
        const getY = t => height - ((tempRange === 0 ? 0.5 : (t - minTemp) / tempRange) * (height - padding * 2) + padding);
        
        const path = validData.map((d, i) => `${i === 0 ? 'M' : 'L'} ${getX(i)},${getY(d.temp)}`).join(' ');
        const dots = validData.map((d, i) => ({ key: d.day, cx: getX(i), cy: getY(d.temp) }));
        return { path, dots };
    }, [data]);

    if (!path) return null;
    return <svg viewBox="0 0 250 40"><path d={path} className="line" />{dots.map(d => <circle key={d.key} cx={d.cx} cy={d.cy} r="3" className="dot" />)}</svg>;
};

const TideForecastChart = ({ data }) => {
    const upcomingEvents = useMemo(() => {
        if (!data || data.length === 0) return [];
        return data.flatMap(day => 
            day.events.map(event => ({ ...event, day: day.day, date: day.date }))
        ).slice(0, 5);
    }, [data]);

    const maxHeight = useMemo(() => {
        if (upcomingEvents.length === 0) return 2.0;
        const max = Math.max(...upcomingEvents.map(e => e.height));
        return Math.ceil(max * 2) / 2;
    }, [upcomingEvents]);
    
    const yAxisLabels = useMemo(() => {
        const labels = [];
        if (maxHeight <= 0) return [];
        for (let i = maxHeight; i >= 0; i -= 0.2) {
             const isMajor = Math.abs(i * 10) % 5 === 0;
            labels.push({ value: i.toFixed(1), isMajor });
        }
        return labels;
    }, [maxHeight]);

    if (upcomingEvents.length === 0) {
        return (
            <section className="tide-forecast-section no-data">
                <Icon name="tide" />
                <span>Tide forecast unavailable</span>
            </section>
        );
    }
    
    return (
        <section className="tide-forecast-section">
            <h2 className="cell-title">Tide Forecast</h2>
            <div className="tide-chart-container">
                <div className="tide-yaxis">
                    {yAxisLabels.map(label => (
                        <div key={label.value} className={`tide-yaxis-item ${label.isMajor ? 'major' : ''}`}>
                            <span>{label.isMajor ? label.value : ''}</span>
                            <div className="tick"></div>
                        </div>
                    ))}
                </div>
                <div className="tide-bars-area">
                    {upcomingEvents.map((event, index) => {
                        const barHeight = Math.max(0, (event.height / maxHeight) * 100);
                        return (
                            <div key={index} className="tide-event-column">
                                <div className="tide-height-label">{event.height.toFixed(1)}M</div>
                                <div className="tide-bar-visual">
                                    <div 
                                        className={`tide-bar-element ${event.type.toLowerCase()}`}
                                        style={{ height: `${barHeight}%` }}
                                    >
                                        <span className="tide-time-label">{event.time}</span>
                                    </div>
                                </div >
                                <div className="tide-day-label">
                                    <span>{event.day}</span>
                                    <span>{event.date}</span>
                                </div>
                            </div>
                        );
                    })}
                </div>
            </div>
        </section>
    );
};

const LocationModal = ({ isOpen, onClose, onLocationChange }) => {
    const [input, setInput] = useState('');
    const [suggestions, setSuggestions] = useState([]);
    const [isSuggesting, setIsSuggesting] = useState(false);
    
    useEffect(() => {
        const handler = setTimeout(() => {
            if (input.length > 2) {
                fetchSuggestions(input);
            } else {
                setSuggestions([]);
            }
        }, 600);
        return () => clearTimeout(handler);
    }, [input]);

    const fetchSuggestions = async (query) => {
        setIsSuggesting(true);
        try {
            const response = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query)}&count=5&format=json`);
            if (!response.ok) throw new Error('Network response was not ok');
            const data = await response.json();
            setSuggestions(data.results || []);
        } catch (error) {
            console.error("Failed to fetch suggestions:", error);
            setSuggestions([]);
        } finally {
            setIsSuggesting(false);
        }
    };
    
    const handleSelect = (suggestion) => {
        setInput(suggestion.name);
        setSuggestions([]);
    };
    
    const handleSubmit = () => {
        if (input.trim()) {
            onLocationChange(input.trim());
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
                        onChange={(e) => setInput(e.target.value)}
                        placeholder="e.g., Tokyo, Japan"
                        autoFocus
                    />
                    {suggestions.length > 0 && (
                        <ul className="suggestions-list">
                            {suggestions.map((s, i) => {
                                const displayText = [s.name, s.admin1, s.country].filter(Boolean).join(', ');
                                return <li key={s.id || i} onClick={() => handleSelect(s)}>{displayText}</li>;
                            })}
                        </ul>
                    )}
                </div>
                <div className="modal-actions">
                    <button onClick={onClose} className="btn-secondary">Cancel</button>
                    <button onClick={handleSubmit} className="btn-primary">Update</button>
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
    if (!isOpen) return null;

    const mapUrl = `https://embed.windy.com/embed.html?lat=${lat}&lon=${lon}&zoom=7&level=surface&overlay=radar&product=radar&menu=&message=&marker=&calendar=now&pressure=&type=map&location=coordinates&detail=&metricWind=km%2Fh&metricTemp=%C2%B0C&radarRange=-1`;

    return (
        <div className="modal-overlay" onClick={onClose}>
            <div className="modal-content alert-modal-content" onClick={e => e.stopPropagation()}>
                <h3>Doppler Weather Radar</h3>
                <div className="map-container">
                    <iframe
                        width="100%"
                        height="100%"
                        src={mapUrl}
                        title="Doppler Weather Radar"
                    ></iframe>
                </div>
                <div className="modal-actions">
                    <button onClick={onClose} className="btn-primary">Close</button>
                </div>
            </div>
        </div>
    );
};

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

// --- Local Tide Simulation ---
const generateTideData = () => {
    const tidesByDate = {};
    const baseDate = new Date();
    baseDate.setHours(0, 0, 0, 0);

    const baseHeight = 1.0;
    const amplitude = 0.8;
    const hoursInDay = 24;
    const cycleHours = 12.4;

    for (let dayOffset = 0; dayOffset < 7; dayOffset++) {
        const currentDate = new Date(baseDate.getTime() + dayOffset * 86400000);
        const dateString = currentDate.toISOString().split('T')[0];
        
        tidesByDate[dateString] = {
            day: currentDate.toLocaleDateString('en-US', { weekday: 'short' }).toUpperCase(),
            date: currentDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
            events: []
        };
        
        for (let hour = 0; hour < hoursInDay; hour += 0.25) {
            const totalHours = dayOffset * hoursInDay + hour;
            const prevTotalHours = totalHours - 0.25;

            const currentHeight = baseHeight + amplitude * Math.sin((totalHours / cycleHours) * 2 * Math.PI);
            const prevHeight = baseHeight + amplitude * Math.sin((prevTotalHours / cycleHours) * 2 * Math.PI);
            
            const eventTime = new Date(currentDate.getTime());
            eventTime.setHours(eventTime.getHours() + hour);

            if (currentHeight > prevHeight && currentHeight > (baseHeight + amplitude * Math.sin(((totalHours + 0.25) / cycleHours) * 2 * Math.PI))) {
                tidesByDate[dateString].events.push({
                    type: 'High',
                    time: eventTime.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }),
                    height: Math.max(0, currentHeight)
                });
            }
            else if (currentHeight < prevHeight && currentHeight < (baseHeight + amplitude * Math.sin(((totalHours + 0.25) / cycleHours) * 2 * Math.PI))) {
                 tidesByDate[dateString].events.push({
                    type: 'Low',
                    time: eventTime.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }),
                    height: Math.max(0, currentHeight)
                });
            }
        }
    }
    return Object.values(tidesByDate);
};

// --- Weather Summary Generator ---
const generateWeatherSummary = (data) => {
    const { hourly } = data;
    const todayStartIndex = 24; 

    if (!hourly?.time?.length || hourly.time.length < todayStartIndex + 24) {
        return `Weather data from Open-Meteo.`;
    }

    const now = new Date();
    const currentHour = now.getHours();
    const currentIndex = todayStartIndex + currentHour;
    
    if (currentIndex >= hourly.time.length) {
         return `Currently, you can expect ${getWmoDescription(hourly.weather_code[hourly.weather_code.length - 1])}.`;
    }

    const currentDesc = getWmoDescription(hourly.weather_code[currentIndex]);

    let nextPeriodName = '';
    let nextPeriodHour = -1;

    if (currentHour < 12) {
        nextPeriodName = 'this afternoon';
        nextPeriodHour = 15;
    } else if (currentHour < 18) {
        nextPeriodName = 'this evening';
        nextPeriodHour = 21;
    } else {
        nextPeriodName = 'overnight';
        nextPeriodHour = 3;
    }
    
    let nextPeriodIndex;
    if (nextPeriodHour > currentHour) {
        nextPeriodIndex = todayStartIndex + nextPeriodHour;
    } else {
        const tomorrowStartIndex = todayStartIndex + 24;
        nextPeriodIndex = tomorrowStartIndex + nextPeriodHour;
    }

    if (nextPeriodIndex >= hourly.time.length) {
        return `Currently, you can expect ${currentDesc}.`;
    }

    const nextPeriodDesc = getWmoDescription(hourly.weather_code[nextPeriodIndex]);
    const remainingTodayTemps = hourly.apparent_temperature.slice(currentIndex, todayStartIndex + 24);
    
    let tempDesc = '';
    if (remainingTodayTemps.length > 0) {
        const maxFeelsLike = Math.round(Math.max(...remainingTodayTemps));
        if (maxFeelsLike > 32) tempDesc = "hot";
        else if (maxFeelsLike > 25) tempDesc = "warm";
        else if (maxFeelsLike > 18) tempDesc = "mild";
        else if (maxFeelsLike > 10) tempDesc = "cool";
        else tempDesc = "cold";
    }

    let summary;
    if (currentDesc === nextPeriodDesc) {
        summary = `Expect ${currentDesc} to continue into ${nextPeriodName}, with ${tempDesc} conditions.`;
    } else {
        summary = `Currently seeing ${currentDesc}, transitioning to ${nextPeriodDesc} ${nextPeriodName}.`;
    }

    return summary.charAt(0).toUpperCase() + summary.slice(1);
};


const NewsTicker = ({ items }) => {
    if (!items || items.length === 0) return null;
    
    const tickerText = items.map(item => item.title).join(' • ');

    return (
        <div className="news-ticker-container">
            <span className="news-ticker-label">LATEST NEWS</span>
            <div className="news-ticker-wrapper">
                <div className="news-ticker-content">
                    <span>{tickerText}</span>
                    <span>{tickerText}</span>
                </div>
            </div>
        </div>
    );
};


const App = () => {
    const [weatherData, setWeatherData] = useState(null);
    const [comparisonCities, setComparisonCities] = useState([]);
    const [newsItems, setNewsItems] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [currentTime, setCurrentTime] = useState(new Date());
    const [currentLocation, setCurrentLocation] = useState("Manila, Philippines");
    const [isLocationModalOpen, setIsLocationModalOpen] = useState(false);
    const [isHourlyModalOpen, setIsHourlyModalOpen] = useState(false);
    const [isAlertModalOpen, setIsAlertModalOpen] = useState(false);
    const [severeWeatherAlert, setSevereWeatherAlert] = useState(false);
    const [lastFetchTime, setLastFetchTime] = useState(null);
    const [timeSinceFetch, setTimeSinceFetch] = useState("00:00");

    useEffect(() => {
        const timer = setInterval(() => setCurrentTime(new Date()), 60000);
        return () => clearInterval(timer);
    }, []);

    useEffect(() => {
        const fetchNews = async () => {
            try {
                const rssUrl = 'https://newsinfo.inquirer.net/category/latest-stories/feed';
                const proxyUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(rssUrl)}`;
                
                const response = await fetch(proxyUrl);
                if (!response.ok) {
                    throw new Error(`Failed to fetch news feed via proxy: ${response.status} ${response.statusText}`);
                }
                
                const xmlText = await response.text();
                const parser = new DOMParser();
                const xmlDoc = parser.parseFromString(xmlText, "application/xml");

                const errorNode = xmlDoc.querySelector("parsererror");
                if (errorNode) {
                    console.error("XML parsing error:", errorNode.textContent);
                    throw new Error("Failed to parse the RSS feed XML.");
                }

                const items = xmlDoc.querySelectorAll("item");
                if (items.length === 0) {
                    setNewsItems([]);
                    return;
                }

                const parsedItems = Array.from(items).map(item => {
                    const titleElement = item.querySelector("title");
                    return {
                        title: titleElement ? titleElement.textContent.trim() : 'Untitled',
                    };
                }).slice(0, 20);

                setNewsItems(parsedItems);

            } catch (error) {
                console.error("News feed error:", error);
                setNewsItems([{ title: "News feed is currently unavailable." }]);
            }
        };
        fetchNews();
    }, []);

    useEffect(() => {
        if (!lastFetchTime) return;

        const timerId = setInterval(() => {
            const now = new Date();
            const diffSeconds = Math.floor((now.getTime() - lastFetchTime.getTime()) / 1000);
            
            const minutes = Math.floor(diffSeconds / 60);
            const seconds = diffSeconds % 60;
            
            const formattedTime = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
            setTimeSinceFetch(formattedTime);
        }, 1000);

        return () => clearInterval(timerId);
    }, [lastFetchTime]);
    
    const fetchWeatherData = useCallback(async (location) => {
        setLoading(true);
        setError(null);
        try {
            const fetchComparisonData = async () => {
                const PHILIPPINE_CITIES = ['Cebu City', 'Davao City', 'Baguio', 'Iloilo City', 'Zamboanga', 'Legazpi'];
                const NCR_CITIES = ['Quezon City', 'Makati', 'Pasig', 'Taguig', 'Mandaluyong'];
                
                const selectedProvincialCities = [...PHILIPPINE_CITIES].sort(() => 0.5 - Math.random()).slice(0, 3);
                const selectedNcrCities = [...NCR_CITIES].sort(() => 0.5 - Math.random()).slice(0, 2);
                const selectedCities = [...selectedProvincialCities, ...selectedNcrCities];

                const promises = selectedCities.map(async (city) => {
                    try {
                        const geo = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&format=json`);
                        const geoData = await geo.json();
                        const { latitude, longitude, name } = geoData.results[0];
                        const weather = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,weather_code`);
                        const weatherData = await weather.json();
                        return {
                            name,
                            temp: weatherData.current.temperature_2m,
                            weatherCode: weatherData.current.weather_code,
                        };
                    } catch {
                        return null;
                    }
                });
                const results = (await Promise.all(promises)).filter(Boolean);
                setComparisonCities(results);
            };

            const geoResponse = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=1&format=json`);
            if (!geoResponse.ok) throw new Error('Failed to geocode location.');
            const geoData = await geoResponse.json();
            if (!geoData.results || geoData.results.length === 0) throw new Error(`Could not find location: ${location}`);
            const { latitude, longitude, name: city, country, timezone } = geoData.results[0];

            const weather_params = new URLSearchParams({
                latitude: String(latitude),
                longitude: String(longitude),
                current: "temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m",
                daily: "weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset,relative_humidity_2m_max,relative_humidity_2m_min",
                hourly: "weather_code,apparent_temperature,temperature_2m,relative_humidity_2m",
                forecast_days: '5',
                past_days: '1',
                timezone: timezone || 'auto'
            });
            const weatherUrl = `https://api.open-meteo.com/v1/forecast?${weather_params}`;
            
            const [weatherResponse] = await Promise.all([
                fetch(weatherUrl),
                fetchComparisonData()
            ]);

            if (!weatherResponse.ok) throw new Error('Failed to fetch weather data from Open-Meteo.');
            const openMeteoData = await weatherResponse.json();
            
            const tideData = generateTideData();
            const summaryText = generateWeatherSummary(openMeteoData);
            
            const yesterdayMaxTemp = openMeteoData.daily.temperature_2m_max[0];
            const todayMaxTemp = openMeteoData.daily.temperature_2m_max[1];
            const tempDiff = todayMaxTemp - yesterdayMaxTemp;
            let comparisonText;

            if (Math.abs(tempDiff) < 2) {
                comparisonText = `Similar to yesterday`;
            } else if (tempDiff > 0) {
                comparisonText = `${Math.round(tempDiff)}° warmer than yesterday`;
            } else {
                comparisonText = `${Math.round(Math.abs(tempDiff))}° cooler than yesterday`;
            }
            
            const now = new Date();
            const currentHour = now.getHours();
            const todayStartIndex = 24; // API returns 1 past day
            const currentIndex = todayStartIndex + currentHour;

            const hourlyData = openMeteoData.hourly.time.slice(currentIndex, currentIndex + 24).map((time, i) => ({
                time: new Date(time).toLocaleTimeString('en-US', { hour: 'numeric', hour12: true }),
                temp: Math.round(openMeteoData.hourly.temperature_2m[currentIndex + i]),
                humidity: openMeteoData.hourly.relative_humidity_2m[currentIndex + i],
                weatherCode: openMeteoData.hourly.weather_code[currentIndex + i],
            }));
            
            const hasSevereWeather = hourlyData.some(hour => [95, 96, 99].includes(hour.weatherCode));
            setSevereWeatherAlert(hasSevereWeather);

            const transformedData = {
                location: { city, country, latitude, longitude },
                current: {
                    temp: openMeteoData.current.temperature_2m,
                    feelsLike: openMeteoData.current.apparent_temperature,
                    summary: summaryText,
                    sunrise: new Date(openMeteoData.daily.sunrise[1]).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true }),
                    sunset: new Date(openMeteoData.daily.sunset[1]).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true }),
                    comparison: comparisonText,
                    clothingSuggestion: openMeteoData.current.temperature_2m > 25 ? 'Light clothing advised' : 'Consider a light jacket',
                    humidity: openMeteoData.current.relative_humidity_2m,
                    windSpeed: openMeteoData.current.wind_speed_10m,
                },
                today: {
                    high: openMeteoData.daily.temperature_2m_max[1],
                    low: openMeteoData.daily.temperature_2m_min[1],
                    highHumidity: openMeteoData.daily.relative_humidity_2m_max[1],
                    lowHumidity: openMeteoData.daily.relative_humidity_2m_min[1],
                },
                forecast: openMeteoData.daily.time.slice(1, 6).map((date, i) => ({
                    day: new Date(date).toLocaleDateString('en-US', { weekday: 'short' }).toUpperCase(),
                    icon: openMeteoData.daily.weather_code[i + 1],
                    temp: openMeteoData.daily.temperature_2m_max[i + 1],
                    humidity: openMeteoData.daily.relative_humidity_2m_max[i + 1],
                })),
                hourly: hourlyData,
                moonPhase: getMoonPhase(),
                tideForecast: tideData
            };

            setWeatherData(transformedData);
            setLastFetchTime(new Date());

        } catch (err) {
            console.error(err);
            setError("Failed to fetch weather data. Please check the location or try again later.");
        } finally {
            setLoading(false);
        }
    }, []);
    
    useEffect(() => {
        const fetchAllData = async () => {
            await fetchWeatherData(currentLocation);
        };

        fetchAllData(); // Initial fetch
        const intervalId = setInterval(fetchAllData, 900000); // Auto-refresh every 15 minutes

        return () => clearInterval(intervalId);
    }, [currentLocation, fetchWeatherData]);

    const handleLocationChange = (newLocation) => {
        setCurrentLocation(newLocation);
    };
    
    const handleManualRefresh = async () => {
        await fetchWeatherData(currentLocation);
    };

    if (loading) return <div className="loading-container">Loading Weather Data...</div>;
    if (error) return <div className="error-container">{error}</div>;
    if (!weatherData) return null;
    
    const { location, current, today, forecast, moonPhase } = weatherData;
    const formattedDate = new Date().toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });

    return (
        <div className="dashboard">
            <LocationModal isOpen={isLocationModalOpen} onClose={() => setIsLocationModalOpen(false)} onLocationChange={handleLocationChange} />
            <HourlyForecastModal isOpen={isHourlyModalOpen} onClose={() => setIsHourlyModalOpen(false)} data={weatherData.hourly} />
            <AlertModal isOpen={isAlertModalOpen} onClose={() => setIsAlertModalOpen(false)} lat={location.latitude} lon={location.longitude} />
            <header className="top-section">
                {severeWeatherAlert && (
                    <button className="alert-button" onClick={() => setIsAlertModalOpen(true)}>
                        Tropical Storm Detected
                    </button>
                )}
                <div className="location-header">
                    <h2>Today in {location?.city}</h2>
                    <button className="edit-btn" onClick={() => setIsLocationModalOpen(true)} aria-label="Change location">
                        <Icon name="edit" />
                    </button>
                </div>
                <div className="current-temp">
                    <h1>{Math.round(current?.temp ?? 0)}°</h1>
                    <div className="current-humidity">
                        <Icon name="humidity" />
                        <span>{current?.humidity ?? 0}%</span>
                    </div>
                </div>
                <div className="weather-details">
                    <span className="date-info">{formattedDate} &middot; {current?.comparison}</span>
                    <span className="feels-like">Feels like {Math.round(current?.feelsLike ?? 0)}°</span>
                    <span className="sun-times">
                        <Icon name="sunrise" /> ↑{current?.sunrise} <Icon name="sunset" /> ↓{current?.sunset}
                    </span>
                </div>
                <div className="summary">
                    <p>{current?.summary}</p>
                </div>
                <div className="clothing-suggestion">
                    <div className="pill">
                        <Icon name="shirt" /> {current?.clothingSuggestion}
                    </div>
                </div>
            </header>

            <main className="main-grid">
                <section className="grid-cell">
                    <div className="cell-header">
                        <h2 className="cell-title">Today's High/Low</h2>
                        <button className="btn-hourly" onClick={() => setIsHourlyModalOpen(true)}>Hourly</button>
                    </div>
                    <div className="today-metrics">
                        <div className="metric-group">
                            <div className="temp-row">
                                <span className="temp-value">{Math.round(today?.high ?? 0)}°</span>
                                <span className="temp-label">HIGH</span>
                            </div>
                            <div className="temp-row">
                                <span className="temp-value">{Math.round(today?.low ?? 0)}°</span>
                                <span className="temp-label">LOW</span>
                            </div>
                        </div>
                        <div className="metric-group">
                             <div className="temp-row">
                                <span className="temp-value">{today?.highHumidity ?? 0}%</span>
                                <span className="temp-label">HIGH HUM.</span>
                            </div>
                            <div className="temp-row">
                                <span className="temp-value">{today?.lowHumidity ?? 0}%</span>
                                <span className="temp-label">LOW HUM.</span>
                            </div>
                        </div>
                    </div>
                </section>
                <section className="grid-cell">
                    <div className="forecast-graph">
                        <ForecastGraph data={forecast} />
                    </div>
                    <div className="forecast-list">
                        {forecast?.map(day => (
                            <div key={day.day} className="forecast-day">
                                <span><Icon name={getWeatherIcon(day.icon)} /> {Math.round(day.temp)}°</span>
                                <span className="forecast-humidity">{day.humidity ?? 0}%</span>
                                <span>{day.day}</span>
                            </div>
                        ))}
                    </div>
                </section>
                <section className="grid-cell details-cell">
                     <TideForecastChart data={weatherData.tideForecast} />
                </section>
            </main>
            
            <section className="comparison-section">
                <h2 className="cell-title">Philippine Outlook</h2>
                <div className="comparison-cities-list">
                    {comparisonCities.map(city => (
                        <div key={city.name} className="comparison-city-item">
                            <span className="city-name">{city.name}</span>
                            <Icon name={getWeatherIcon(city.weatherCode)} />
                            <span className="city-temp">{Math.round(city.temp)}°</span>
                        </div>
                    ))}
                </div>
            </section>

            <NewsTicker items={newsItems} />
            
            <footer className="footer">
                <div className="footer-details">
                    <div className="data-row"><Icon name="moon" /> {moonPhase?.toUpperCase()}</div>
                    <div className="data-row"><Icon name="history" /> {timeSinceFetch}</div>
                </div>
                <button className="refresh-btn" onClick={handleManualRefresh} aria-label="Refresh weather data">
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