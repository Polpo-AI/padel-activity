import fs from 'fs';
import path from 'path';

/**
 * Carica un file di prompt (.md) dalla cartella src/prompts/
 * e sostituisce i placeholder forniti.
 * 
 * Esempio:
 * loadPrompt('classify_intent', { text: 'ciao', history: '...' })
 */
export function loadPrompt(name: string, replacements: Record<string, string>): string {
    const filePath = path.join(__dirname, '../prompts', `${name}.md`);
    if (!fs.existsSync(filePath)) {
        throw new Error(`Prompt file not found: ${name}`);
    }
    let content = fs.readFileSync(filePath, 'utf-8');

    for (const [key, value] of Object.entries(replacements)) {
        const placeholder = `{{${key}}}`;
        content = content.replace(new RegExp(placeholder, 'g'), value || '');
    }

    return content;
}
