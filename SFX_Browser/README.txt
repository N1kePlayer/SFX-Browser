SFX Browser Adobe v0.8.0

- Premiere Pro + After Effects CEP panel
- Your own folder structure; no automatic sorting
- Folder/audio icons inspired by FL Studio Browser
- Favorites: star any sound and open FAVORITES view
- Hidden sounds/folders remain on disk and can be restored
- Click = preview/select only
- Double-click does NOT add to timeline
- ADD is the only automatic timeline insertion action
- Premiere ADD chooses the visually lowest existing audio track that is free exactly at the playhead position
- Waveform, preview volume, file information and per-file notes
- Drag & drop payload remains available where the Adobe host accepts CEP file dragging


v0.7.4: cleaned preview; removed inspector favorite button; redesigned folder icon; file extensions hidden from visible names.


v0.8.0: fixed Premiere timeline ADD using version-compatible seconds/ticks insertion strategies and actual timeline verification; Hidden/Restore now preserves expanded/collapsed folder state.


v0.8.0: Fixed Premiere ADD timing units: Track.overwriteClip now receives seconds (Adobe CEP API), not ticks. Result is verified by track contents after a longer host update delay.


v0.8.2: self-contained WAV preview decoder (PCM/IEEE float/A-law/mu-law), no ffmpeg or OS converter required. Preview playhead retained. ADD logic unchanged from v0.8.0.
