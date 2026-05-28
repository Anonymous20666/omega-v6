// core/sanitizer.js

/**
 * Escapes characters that could be executed as HTML/XSS.
 * Crucial for Group Names or user-generated text passed to Dashboards.
 */
function escapeHTML(text) {
    if (!text) return "";
    return text.toString()
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")   // Added quote protection
        .replace(/'/g, "&#039;");  // Added single quote protection
}

module.exports = { escapeHTML };
