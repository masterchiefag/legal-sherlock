import { Router } from 'express';

const router = Router();

// POST /api/playground — freeform LLM prompt
router.post('/', async (req, res) => {
    const { prompt, model, system_prompt, temperature, max_tokens } = req.body;

    if (!prompt?.trim()) {
        return res.status(400).json({ error: 'prompt is required' });
    }

    const ollamaUrl = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
    const activeModel = model || process.env.OLLAMA_MODEL || 'gemma3:4b';

    try {
        const start = Date.now();
        const response = await fetch(`${ollamaUrl}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: activeModel,
                messages: [
                    ...(system_prompt ? [{ role: 'system', content: system_prompt }] : []),
                    { role: 'user', content: prompt },
                ],
                stream: false,
                options: {
                    temperature: temperature ?? 0.7,
                    num_predict: max_tokens || 1024,
                    num_ctx: 4096,
                },
            }),
        });

        if (!response.ok) {
            const errText = await response.text();
            return res.status(502).json({ error: `Ollama error (${response.status}): ${errText}` });
        }

        const data = await response.json();
        const elapsed = ((Date.now() - start) / 1000).toFixed(1);

        res.json({
            response: data.message?.content || '',
            model: activeModel,
            elapsed_seconds: parseFloat(elapsed),
            eval_count: data.eval_count || 0,
            prompt_eval_count: data.prompt_eval_count || 0,
        });
    } catch (err) {
        console.error('Playground error:', err.message);
        const isConnectionError = err.cause?.code === 'ECONNREFUSED' || err.message.includes('fetch failed');
        res.status(502).json({
            error: isConnectionError
                ? 'Ollama is not running. Start it with: ollama serve'
                : `LLM error: ${err.message}`
        });
    }
});

export default router;
