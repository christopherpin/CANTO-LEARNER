# Canto Learner

A small Cantonese learning app that runs in the browser on phone and laptop.

**Use it:** https://christopherpin.github.io/CANTO-LEARNER/

Built around one goal: holding everyday conversations with family within a year.

- **Today's plan:** each day shows flashcards, one speaking practice, and an optional character drill, plus where you are in a 12-month plan.
- **Speak:** six role-play conversations (meeting relatives, dinner, kids, phone call, yum cha, small talk) and 18 sentence patterns, with self-recording to compare against the audio.
- **Characters:** an optional daily drill of 150 common characters, each linked to words you're learning.
- **Tones:** the six tones with pitch diagrams, minimal sets to listen to, and a tone quiz.
- **Jyutping guide:** initials and finals with English approximations and audio.
- **Flashcards:** about 400 words, phrases and pattern sentences with spaced repetition. New words are shown in Cantonese first; once you know them, most cards show English so you practise saying the Cantonese.
- **Phrases:** family gatherings, talking with kids, eating out, getting unstuck.
- **Audio:** uses the device's Cantonese (zh-HK) text-to-speech voice. See Settings in the app for how to install one.

Progress is saved in the browser (localStorage). Use **More → Settings → Backup & sync** to copy progress between devices. Add it to your home screen for an app-like, offline experience.

## Editing content

All words and phrases are in `js/data.js` as `[characters, jyutping, english, note]`. Add a row, commit, and GitHub Pages redeploys. Bump `CACHE` in `sw.js` when you change files so installed copies update.

No build step: plain HTML, CSS and JavaScript.
