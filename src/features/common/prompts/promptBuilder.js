const { profilePrompts } = require('./promptTemplates.js');

function buildSystemPrompt(promptParts, customPrompt = '', googleSearchEnabled = true) {
    const sections = [promptParts.intro, '\n\n', promptParts.formatRequirements];

    if (googleSearchEnabled) {
        sections.push('\n\n', promptParts.searchUsage);
    }

    sections.push('\n\n', promptParts.content, '\n\nUser-provided context\n-----\n', customPrompt, '\n-----\n\n', promptParts.outputInstructions);

    return sections.join('');
}

function getSystemPrompt(profile, customPrompt = '', googleSearchEnabled = true, userPresetText = '') {
    const trimmedPreset = (userPresetText || '').trim();

    if (trimmedPreset) {
        // The user-selected preset replaces the default profile entirely. Default presets
        // (school/sales/meetings/...) and custom user presets are written as full
        // role descriptions ("You are a ...") and are meant to define the assistant's
        // identity, not to be a hint layered on top of another system prompt.
        const sections = [trimmedPreset];
        if (customPrompt && customPrompt.trim().length > 0) {
            sections.push('\n\nConversation transcript:\n-----\n', customPrompt, '\n-----');
        } else {
            // Preserve the {{CONVERSATION_HISTORY}} placeholder so summaryService's
            // .replace() injection keeps working when customPrompt is empty.
            sections.push('\n\n{{CONVERSATION_HISTORY}}');
        }
        return sections.join('');
    }

    const promptParts = profilePrompts[profile] || profilePrompts.interview;
    return buildSystemPrompt(promptParts, customPrompt, googleSearchEnabled);
}

module.exports = {
    getSystemPrompt,
};
