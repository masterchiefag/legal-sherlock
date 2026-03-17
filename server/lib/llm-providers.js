/**
 * LLM Provider Abstraction Layer
 * 
 * Swappable backends for document classification. Set LLM_PROVIDER env var:
 *   - "ollama" (default) — local Ollama server
 *   - "openai" — OpenAI API
 *   - "anthropic" — Anthropic API
 */

// ═══════════════════════════════════════════════════
// Ollama Provider (Local)
// ═══════════════════════════════════════════════════
class OllamaProvider {
    constructor() {
        this.baseUrl = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
        this.model = process.env.OLLAMA_MODEL || 'gemma3:4b';
    }

    get name() { return 'ollama'; }
    get modelName() { return this.model; }

    async classify(systemPrompt, documentContent, overrideModel = null) {
        const fullPrompt = `${systemPrompt}\n\n--- DOCUMENT START ---\n${documentContent}\n--- DOCUMENT END ---\n\nRespond ONLY with valid JSON in this exact format: {"score": <1-5>, "reasoning": "<brief explanation>"}`;
        const activeModel = overrideModel || this.model;

        const response = await fetch(`${this.baseUrl}/api/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: activeModel,
                prompt: fullPrompt,
                stream: false,
                options: {
                    temperature: 0.1,       // Low temp for consistent scoring
                    num_predict: 80,        // JSON response is ~30-50 tokens
                    num_ctx: 2048,          // Smaller context = faster inference
                    num_thread: 8,          // Use all CPU cores
                },
            }),
        });

        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`Ollama error (${response.status}): ${errText}`);
        }

        const data = await response.json();
        return this.parseResponse(data.response);
    }

    parseResponse(rawText) {
        // Try to extract JSON from the response
        const jsonMatch = rawText.match(/\{[\s\S]*?"score"[\s\S]*?"reasoning"[\s\S]*?\}/);
        if (jsonMatch) {
            try {
                const parsed = JSON.parse(jsonMatch[0]);
                return {
                    score: Math.min(5, Math.max(1, parseInt(parsed.score) || 3)),
                    reasoning: parsed.reasoning || 'No reasoning provided.',
                };
            } catch (e) { /* fall through */ }
        }

        // Fallback: try to find a number 1-5 in the response
        const scoreMatch = rawText.match(/\b([1-5])\b/);
        return {
            score: scoreMatch ? parseInt(scoreMatch[1]) : 3,
            reasoning: rawText.substring(0, 500).trim() || 'Could not parse structured response.',
        };
    }
}

// ═══════════════════════════════════════════════════
// OpenAI Provider (Cloud — for future use)
// ═══════════════════════════════════════════════════
class OpenAIProvider {
    constructor() {
        this.apiKey = process.env.OPENAI_API_KEY;
        this.model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
    }

    get name() { return 'openai'; }
    get modelName() { return this.model; }

    async classify(systemPrompt, documentContent, overrideModel = null) {
        if (!this.apiKey) throw new Error('OPENAI_API_KEY not set');
        const activeModel = overrideModel || this.model;

        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.apiKey}`,
            },
            body: JSON.stringify({
                model: activeModel,
                temperature: 0.1,
                response_format: { type: 'json_object' },
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: `Classify this document:\n\n${documentContent}\n\nRespond with JSON: {"score": <1-5>, "reasoning": "<explanation>"}` },
                ],
            }),
        });

        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`OpenAI error (${response.status}): ${errText}`);
        }

        const data = await response.json();
        const raw = data.choices[0]?.message?.content || '';
        return new OllamaProvider().parseResponse(raw); // reuse the robust parser
    }
}

// ═══════════════════════════════════════════════════
// Anthropic Provider (Cloud — for future use)
// ═══════════════════════════════════════════════════
class AnthropicProvider {
    constructor() {
        this.apiKey = process.env.ANTHROPIC_API_KEY;
        this.model = process.env.ANTHROPIC_MODEL || 'claude-3-5-haiku-20241022';
    }

    get name() { return 'anthropic'; }
    get modelName() { return this.model; }

    async classify(systemPrompt, documentContent, overrideModel = null) {
        if (!this.apiKey) throw new Error('ANTHROPIC_API_KEY not set');
        const activeModel = overrideModel || this.model;

        const response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': this.apiKey,
                'anthropic-version': '2023-06-01',
            },
            body: JSON.stringify({
                model: activeModel,
                max_tokens: 300,
                temperature: 0.1,
                system: systemPrompt,
                messages: [
                    { role: 'user', content: `Classify this document:\n\n${documentContent}\n\nRespond ONLY with valid JSON: {"score": <1-5>, "reasoning": "<explanation>"}` },
                ],
            }),
        });

        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`Anthropic error (${response.status}): ${errText}`);
        }

        const data = await response.json();
        const raw = data.content[0]?.text || '';
        return new OllamaProvider().parseResponse(raw);
    }
}

// ═══════════════════════════════════════════════════
// Provider Factory
// ═══════════════════════════════════════════════════
const providers = {
    ollama: OllamaProvider,
    openai: OpenAIProvider,
    anthropic: AnthropicProvider,
};

export function getProvider() {
    const name = (process.env.LLM_PROVIDER || 'ollama').toLowerCase();
    const ProviderClass = providers[name];
    if (!ProviderClass) {
        throw new Error(`Unknown LLM provider: "${name}". Available: ${Object.keys(providers).join(', ')}`);
    }
    return new ProviderClass();
}

export function listProviders() {
    return Object.keys(providers);
}
