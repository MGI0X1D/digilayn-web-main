// theme.js - Universal theme handler
(function() {
    const html = document.documentElement;

    // 1. Apply theme based on saved preference or system preference
    const applyTheme = () => {
        const savedTheme = localStorage.getItem('theme');
        if (savedTheme) {
            if (savedTheme === 'dark') {
                html.classList.add('dark');
            } else {
                html.classList.remove('dark');
            }
        } else {
            // Fallback to system default if no manual preference is saved
            if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
                html.classList.add('dark');
            } else {
                html.classList.remove('dark');
            }
        }
    };

    // Initial check
    applyTheme();

    // Listen for system changes (only apply if no manual preference is set)
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', e => {
        if (!localStorage.getItem('theme')) {
            if (e.matches) {
                html.classList.add('dark');
            } else {
                html.classList.remove('dark');
            }
            window.dispatchEvent(new Event('themeChanged'));
        }
    });

    // 2. DOMContentLoaded logic for pages that still have a toggle
    const initTheme = () => {
        const themeToggle = document.getElementById('theme-toggle');
        const themeIcon = document.getElementById('theme-icon');

        const updateIcon = () => {
            if (!themeIcon) return;
            themeIcon.textContent = html.classList.contains('dark') ? '☀️' : '🌙';
        };

        updateIcon();

        if (themeToggle) {
            themeToggle.addEventListener('click', () => {
                const isDark = html.classList.toggle('dark');
                localStorage.setItem('theme', isDark ? 'dark' : 'light');
                updateIcon();
                window.dispatchEvent(new Event('themeChanged'));
            });
        }
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initTheme);
    } else {
        initTheme();
    }
})();