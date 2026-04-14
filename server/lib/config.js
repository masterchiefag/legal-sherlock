import { getSetting } from './settings.js';

// LLM context limits — reads from DB-backed system settings on each access
export function getLlmLimits() {
    return {
        MAX_BODY_CHARS: getSetting('llm_max_body_chars') || 100000,
        MAX_THREAD_CHARS: getSetting('llm_max_thread_chars') || 1500,
        MAX_ATTACHMENT_CHARS: getSetting('llm_max_attachment_chars') || 1500,
    };
}

// Keep backward-compatible named export for existing consumers
// (reads live values on each property access)
export const LLM_LIMITS = new Proxy({}, {
    get(_, prop) {
        return getLlmLimits()[prop];
    }
});
