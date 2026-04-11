import { useState, useEffect, useRef } from 'react';
import { apiFetch } from '../utils/api';

function Playground({ addToast }) {
    const [prompt, setPrompt] = useState('');
    const [systemPrompt, setSystemPrompt] = useState('');
    const [model, setModel] = useState('');
    const [models, setModels] = useState([]);
    const [temperature, setTemperature] = useState(0.7);
    const [maxTokens, setMaxTokens] = useState(1024);
    const [response, setResponse] = useState('');
    const [loading, setLoading] = useState(false);
    const [stats, setStats] = useState(null);
    const [showSettings, setShowSettings] = useState(false);
    const [history, setHistory] = useState([]);
    const textareaRef = useRef(null);

    useEffect(() => {
        apiFetch('/api/classify/models')
            .then(r => r.json())
            .then(data => {
                setModels(data.models || []);
                if (data.active_model) setModel(data.active_model);
                else if (data.models?.length) setModel(data.models[0]);
            })
            .catch(() => {});
    }, []);

    const handleSubmit = async () => {
        if (!prompt.trim() || loading) return;
        setLoading(true);
        setResponse('');
        setStats(null);

        try {
            const res = await apiFetch('/api/playground', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    prompt: prompt.trim(),
                    model: model || undefined,
                    system_prompt: systemPrompt.trim() || undefined,
                    temperature,
                    max_tokens: maxTokens,
                }),
            });

            const data = await res.json();
            if (data.error) {
                addToast(data.error, 'error');
                setResponse('');
            } else {
                setResponse(data.response);
                setStats({
                    model: data.model,
                    elapsed: data.elapsed_seconds,
                    tokens: data.eval_count,
                    promptTokens: data.prompt_eval_count,
                });
                setHistory(prev => [{
                    prompt: prompt.trim(),
                    response: data.response,
                    model: data.model,
                    elapsed: data.elapsed_seconds,
                    timestamp: new Date().toLocaleTimeString(),
                }, ...prev].slice(0, 20));
            }
        } catch (err) {
            addToast('Failed to reach server', 'error');
        }

        setLoading(false);
    };

    const handleKeyDown = (e) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            handleSubmit();
        }
    };

    const loadHistoryItem = (item) => {
        setPrompt(item.prompt);
        setResponse(item.response);
        setStats({ model: item.model, elapsed: item.elapsed });
    };

    return (
        <div style={{ display: 'flex', gap: '24px', height: 'calc(100vh - 100px)' }}>
            {/* Main area */}
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                {/* Settings toggle */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '16px' }}>
                    <select
                        className="select"
                        value={model}
                        onChange={e => setModel(e.target.value)}
                        style={{ width: '200px' }}
                    >
                        {models.length === 0 && <option value="">No models available</option>}
                        {models.map(m => <option key={m} value={m}>{m}</option>)}
                    </select>
                    <button
                        className="btn btn-secondary"
                        onClick={() => setShowSettings(!showSettings)}
                        style={{ fontSize: '13px' }}
                    >
                        {showSettings ? 'Hide Settings' : 'Settings'}
                    </button>
                    {stats && (
                        <div style={{ marginLeft: 'auto', fontSize: '12px', color: 'var(--text-tertiary)', display: 'flex', gap: '16px' }}>
                            <span>{stats.model}</span>
                            <span>{stats.elapsed}s</span>
                            {stats.tokens > 0 && <span>{stats.tokens} tokens</span>}
                        </div>
                    )}
                </div>

                {/* Settings panel */}
                {showSettings && (
                    <div className="card" style={{ padding: '16px', marginBottom: '16px', display: 'flex', gap: '20px', flexWrap: 'wrap' }}>
                        <div style={{ flex: '1 1 300px' }}>
                            <label className="text-sm text-secondary block mb-8">System Prompt</label>
                            <textarea
                                className="input"
                                value={systemPrompt}
                                onChange={e => setSystemPrompt(e.target.value)}
                                placeholder="You are a helpful assistant..."
                                rows={3}
                                style={{ width: '100%', resize: 'vertical', fontFamily: 'inherit' }}
                            />
                        </div>
                        <div>
                            <label className="text-sm text-secondary block mb-8">Temperature: {temperature}</label>
                            <input
                                type="range"
                                min="0"
                                max="2"
                                step="0.1"
                                value={temperature}
                                onChange={e => setTemperature(parseFloat(e.target.value))}
                                style={{ width: '150px' }}
                            />
                        </div>
                        <div>
                            <label className="text-sm text-secondary block mb-8">Max Tokens</label>
                            <input
                                className="input"
                                type="number"
                                value={maxTokens}
                                onChange={e => setMaxTokens(parseInt(e.target.value) || 1024)}
                                min={64}
                                max={8192}
                                style={{ width: '100px' }}
                            />
                        </div>
                    </div>
                )}

                {/* Prompt input */}
                <div style={{ marginBottom: '12px' }}>
                    <textarea
                        ref={textareaRef}
                        className="input"
                        value={prompt}
                        onChange={e => setPrompt(e.target.value)}
                        onKeyDown={handleKeyDown}
                        placeholder="Type your prompt here... (Cmd+Enter to send)"
                        rows={5}
                        style={{ width: '100%', resize: 'vertical', fontFamily: 'inherit', fontSize: '14px' }}
                        disabled={loading}
                    />
                </div>

                <div style={{ display: 'flex', gap: '8px', marginBottom: '16px' }}>
                    <button
                        className="btn btn-primary"
                        onClick={handleSubmit}
                        disabled={loading || !prompt.trim()}
                    >
                        {loading ? (
                            <>
                                <span className="spinner" style={{ width: '14px', height: '14px', marginRight: '8px' }}></span>
                                Generating...
                            </>
                        ) : 'Send'}
                    </button>
                    <button
                        className="btn btn-secondary"
                        onClick={() => { setPrompt(''); setResponse(''); setStats(null); }}
                        disabled={loading}
                    >
                        Clear
                    </button>
                </div>

                {/* Response */}
                <div
                    className="card"
                    style={{
                        flex: 1,
                        padding: '20px',
                        overflow: 'auto',
                        fontFamily: 'inherit',
                        fontSize: '14px',
                        lineHeight: '1.7',
                        whiteSpace: 'pre-wrap',
                        color: response ? 'var(--text-primary)' : 'var(--text-tertiary)',
                    }}
                >
                    {loading ? (
                        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                            <span className="spinner" style={{ width: '18px', height: '18px' }}></span>
                            <span>Thinking...</span>
                        </div>
                    ) : response || 'Response will appear here...'}
                </div>
            </div>

            {/* History sidebar */}
            {history.length > 0 && (
                <div style={{ width: '260px', flexShrink: 0, overflow: 'auto' }}>
                    <div className="text-sm text-secondary" style={{ marginBottom: '12px', fontWeight: 600 }}>
                        History ({history.length})
                    </div>
                    {history.map((item, i) => (
                        <div
                            key={i}
                            className="card"
                            onClick={() => loadHistoryItem(item)}
                            style={{
                                padding: '12px',
                                marginBottom: '8px',
                                cursor: 'pointer',
                                transition: 'border-color 0.15s',
                            }}
                            onMouseOver={e => e.currentTarget.style.borderColor = 'var(--border-accent)'}
                            onMouseOut={e => e.currentTarget.style.borderColor = ''}
                        >
                            <div style={{
                                fontSize: '12px',
                                color: 'var(--text-primary)',
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                                marginBottom: '4px',
                            }}>
                                {item.prompt.substring(0, 80)}
                            </div>
                            <div style={{ fontSize: '11px', color: 'var(--text-tertiary)', display: 'flex', gap: '8px' }}>
                                <span>{item.model}</span>
                                <span>{item.elapsed}s</span>
                                <span>{item.timestamp}</span>
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

export default Playground;
