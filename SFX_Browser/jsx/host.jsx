$._sfx = $._sfx || {};

$._sfx._host = function(){
    var bt='', an='';
    try { bt=String(BridgeTalk.appName || '').toLowerCase(); } catch(e0){}
    try { an=String(app.name || '').toLowerCase(); } catch(e1){}
    if (bt.indexOf('premierepro') >= 0 || bt.indexOf('premiere') >= 0 || an.indexOf('premiere pro') >= 0 || an.indexOf('premiere') >= 0 || an.indexOf('ppro') >= 0) return 'PPRO';
    if (bt.indexOf('aftereffects') >= 0 || bt.indexOf('after effects') >= 0 || an.indexOf('after effects') >= 0 || an.indexOf('aftereffects') >= 0 || an.indexOf('aeft') >= 0) return 'AEFT';
    return 'UNKNOWN|BridgeTalk='+bt+'|app.name='+an;
};

$._sfx._normPath = function(p){
    try { return decodeURI(String(p)).replace(/\\/g,'/').toLowerCase(); }
    catch(e){ return String(p).replace(/\\/g,'/').toLowerCase(); }
};

$._sfx._collectionItem = function(col, index){
    try { if (col && col[index] !== undefined && col[index] !== null) return col[index]; } catch(e){}
    return null;
};

$._sfx._collectionCount = function(col, preferredProp){
    if(!col) return 0;
    try{ if(preferredProp && col[preferredProp] !== undefined) return Number(col[preferredProp]); }catch(e0){}
    try{ if(col.numItems !== undefined) return Number(col.numItems); }catch(e1){}
    try{ if(col.length !== undefined) return Number(col.length); }catch(e2){}
    return 0;
};

$._sfx._findProjectItem = function(parent, mediaPath){
    if (!parent || !parent.children) return null;
    var wanted=$._sfx._normPath(mediaPath), count=$._sfx._collectionCount(parent.children,'numItems');
    for (var base=0;base<=1;base++) {
        for (var n=0;n<count;n++) {
            var it=$._sfx._collectionItem(parent.children,n+base);
            if(!it) continue;
            try { if (it.getMediaPath) { var got=it.getMediaPath(); if(got && $._sfx._normPath(got)===wanted) return it; } } catch(e2){}
            try { if (it.children) { var found=$._sfx._findProjectItem(it,mediaPath); if(found) return found; } } catch(e3){}
        }
    }
    return null;
};

$._sfx._ticks = function(timeObj){
    try { return Number(String(timeObj.ticks)); } catch(e0){}
    return NaN;
};

$._sfx._itemDurationTicks = function(item){
    try{
        var outT=item.getOutPoint ? item.getOutPoint(2) : null;
        var inT=item.getInPoint ? item.getInPoint() : null;
        var o=$._sfx._ticks(outT), i=$._sfx._ticks(inT);
        if(!isNaN(o) && !isNaN(i) && o>i) return o-i;
    }catch(e0){}
    return 0;
};

$._sfx._trackIsFreeForRange = function(track, startTicks, endTicks){
    if(!track) return false;
    try{ if(track.isLocked && track.isLocked()) return false; }catch(e0){}
    var clips=null; try{clips=track.clips;}catch(e1){clips=null;}
    if(!clips) return true;
    var count=$._sfx._collectionCount(clips,'numItems');
    if(count<1) return true;
    for(var base=0;base<=1;base++){
        for(var i=0;i<count;i++){
            var clip=$._sfx._collectionItem(clips,i+base);
            if(!clip) continue;
            try{
                var s=$._sfx._ticks(clip.start), e=$._sfx._ticks(clip.end);
                if(isNaN(s) || isNaN(e)) continue;
                if(endTicks>startTicks){
                    if(s < endTicks && e > startTicks) return false;
                }else if(startTicks>=s && startTicks<e){
                    return false;
                }
            }catch(e2){}
        }
    }
    return true;
};

$._sfx._getBottomFreeAudioTrack = function(seq, pos, durationTicks){
    if(!seq || !seq.audioTracks) return null;
    var count=$._sfx._collectionCount(seq.audioTracks,'numTracks');
    if(count<1) return null;
    var startTicks=$._sfx._ticks(pos);
    if(isNaN(startTicks)) return null;
    var endTicks=startTicks + (durationTicks>0 ? durationTicks : 0);
    // Highest index is the bottom-most / last audio track in Premiere.
    for(var n=count-1;n>=0;n--){
        var t=$._sfx._collectionItem(seq.audioTracks,n);
        if(t && $._sfx._trackIsFreeForRange(t,startTicks,endTicks)) return {track:t,index:n};
    }
    // Fallback for one-based collection implementations.
    for(var m=count;m>=1;m--){
        var t2=$._sfx._collectionItem(seq.audioTracks,m);
        if(t2 && $._sfx._trackIsFreeForRange(t2,startTicks,endTicks)) return {track:t2,index:m-1};
    }
    return null;
};

$._sfx._trackHasClipAt = function(track, startTicks, mediaPath){
    if(!track || !track.clips) return false;
    var wanted=$._sfx._normPath(mediaPath), count=$._sfx._collectionCount(track.clips,'numItems');
    for(var i=0;i<count;i++){
        var clip=$._sfx._collectionItem(track.clips,i);
        if(!clip) continue;
        try{
            var s=$._sfx._ticks(clip.start);
            var mp=''; try{if(clip.projectItem&&clip.projectItem.getMediaPath)mp=clip.projectItem.getMediaPath();}catch(e0){}
            if(Math.abs(s-startTicks)<2 && (!mp || $._sfx._normPath(mp)===wanted)) return true;
        }catch(e1){}
    }
    return false;
};

$._sfx._waitForProjectItem = function(mediaPath, maxMs){
    var waited=0, step=100, item=null;
    while(waited<=maxMs){
        item=$._sfx._findProjectItem(app.project.rootItem,mediaPath);
        if(item){
            try{ if(item.refreshMedia) item.refreshMedia(); }catch(e0){}
            return item;
        }
        $.sleep(step);
        waited+=step;
    }
    return null;
};

$._sfx._verifyAdded = function(seq, trackIndex, startTicks, mediaPath){
    try{
        var t=$._sfx._collectionItem(seq.audioTracks,trackIndex);
        if(t && $._sfx._trackHasClipAt(t,startTicks,mediaPath)) return true;
    }catch(e0){}
    return false;
};

$._sfx.insert = function(mediaPath, mediaDurationSeconds){
    var stage='start';
    try {
        if (!mediaPath) return 'ADD error [path]: empty media path';
        var host=$._sfx._host();

        if (host === 'PPRO') {
            stage='project';
            if (!app.project) return 'ADD error [project]: open a Premiere project';
            var seq=app.project.activeSequence;
            if (!seq) return 'ADD error [sequence]: open a sequence in Premiere';

            // Get/import the ProjectItem, then wait until Premiere has actually registered it.
            stage='project item';
            var item=$._sfx._findProjectItem(app.project.rootItem,mediaPath);
            if(!item){
                stage='import';
                var imported=app.project.importFiles([mediaPath],true,app.project.rootItem,false);
                if(imported===false) return 'ADD error [import]: Premiere rejected the audio file';
                item=$._sfx._waitForProjectItem(mediaPath,4000);
            }else{
                try{ if(item.refreshMedia) item.refreshMedia(); }catch(er0){}
            }
            if(!item) return 'ADD error [import]: imported file was not ready after 4 seconds';

            // Give Premiere a short conform/registration window. This is the race that made 0.7.8 intermittent.
            $.sleep(250);
            item=$._sfx._findProjectItem(app.project.rootItem,mediaPath) || item;

            stage='playhead';
            seq=app.project.activeSequence; // reacquire after import/wait
            if(!seq) return 'ADD error [sequence]: active sequence disappeared';
            var pos=seq.getPlayerPosition();
            if(!pos || pos.ticks===undefined) return 'ADD error [playhead]: could not read playhead position';
            var startTicks=$._sfx._ticks(pos);
            if(isNaN(startTicks)) return 'ADD error [playhead]: invalid playhead ticks';
            var posSeconds=0;
            try{ posSeconds=Number(pos.seconds); }catch(eps){ posSeconds=startTicks/254016000000; }
            if(isNaN(posSeconds)) posSeconds=startTicks/254016000000;

            stage='duration';
            var durationTicks=0;
            if(mediaDurationSeconds && Number(mediaDurationSeconds)>0) durationTicks=Math.round(Number(mediaDurationSeconds)*254016000000);
            if(!(durationTicks>0)) durationTicks=$._sfx._itemDurationTicks(item);
            if(!(durationTicks>0)) durationTicks=1;
            var endTicks=startTicks+durationTicks;

            stage='audio tracks';
            if(!seq.audioTracks) return 'ADD error [tracks]: sequence has no audio track collection';
            var count=$._sfx._collectionCount(seq.audioTracks,'numTracks');
            if(count<1) return 'ADD error [tracks]: sequence has no audio tracks';

            // Build the candidate list once: bottom-most free track first.
            var candidates=[];
            for(var ci=count-1;ci>=0;ci--){
                var ct=$._sfx._collectionItem(seq.audioTracks,ci);
                if(ct && $._sfx._trackIsFreeForRange(ct,startTicks,endTicks)) candidates.push(ci);
            }
            if(!candidates.length) return 'ADD: no existing audio track is free for the full sound at the playhead';

            var attempts=[];
            // 0.7.8 proved that seconds + Track.overwriteClip works on this Premiere build.
            // Make that same path deterministic: reacquire everything and retry if Premiere is still conforming media.
            for(var c=0;c<candidates.length;c++){
                var idx=candidates[c];
                for(var retry=1;retry<=5;retry++){
                    stage='A'+(idx+1)+' overwrite retry '+retry;
                    seq=app.project.activeSequence;
                    if(!seq) return 'ADD error [sequence]: active sequence disappeared';
                    var track=$._sfx._collectionItem(seq.audioTracks,idx);
                    if(!track){ attempts.push('A'+(idx+1)+' missing track'); break; }

                    // Re-find the ProjectItem each retry; Premiere can replace its wrapper after import/conform.
                    item=$._sfx._findProjectItem(app.project.rootItem,mediaPath) || item;
                    try{ if(item.refreshMedia) item.refreshMedia(); }catch(er1){}

                    try{
                        var before=$._sfx._collectionCount(track.clips,'numItems');
                        track.overwriteClip(item,posSeconds);
                        $.sleep(220 + retry*120);

                        // Reacquire sequence/track before verifying; collections can be stale after timeline edits.
                        seq=app.project.activeSequence;
                        track=$._sfx._collectionItem(seq.audioTracks,idx);
                        var after=$._sfx._collectionCount(track.clips,'numItems');
                        if(after>before || $._sfx._trackHasClipAt(track,startTicks,mediaPath)){
                            return 'Added · A'+(idx+1)+' · bottom free track';
                        }
                        attempts.push('A'+(idx+1)+' try '+retry+' no clip');
                    }catch(e1){
                        attempts.push('A'+(idx+1)+' try '+retry+' '+e1.toString());
                    }
                    $.sleep(150);
                }
            }

            // Last conservative fallback: explicit sequence overwrite, still only onto a previously verified free track.
            for(var f=0;f<candidates.length;f++){
                var fi=candidates[f];
                try{
                    stage='A'+(fi+1)+' sequence fallback';
                    seq=app.project.activeSequence;
                    var ft=$._sfx._collectionItem(seq.audioTracks,fi);
                    var fb=$._sfx._collectionCount(ft.clips,'numItems');
                    if(seq.overwriteClip) seq.overwriteClip(item,posSeconds,0,fi);
                    $.sleep(700);
                    seq=app.project.activeSequence;
                    ft=$._sfx._collectionItem(seq.audioTracks,fi);
                    var fa=$._sfx._collectionCount(ft.clips,'numItems');
                    if(fa>fb || $._sfx._trackHasClipAt(ft,startTicks,mediaPath)) return 'Added · A'+(fi+1)+' · bottom free track';
                }catch(ef){ attempts.push('A'+(fi+1)+' fallback '+ef.toString()); }
            }

            return 'ADD failed after retries · '+attempts.slice(-12).join(' | ');
        }

        if (host === 'AEFT') {
            stage='AE comp';
            var comp=app.project && app.project.activeItem;
            if(!(comp && comp instanceof CompItem)) return 'ADD error [AE]: open a composition';
            stage='AE import';
            var f=new File(mediaPath);
            if(!f.exists) return 'ADD error [AE]: file not found';
            var itemAE=null;
            for(var i=1;i<=app.project.numItems;i++){
                try{var pi=app.project.item(i);if(pi instanceof FootageItem && pi.file && $._sfx._normPath(pi.file.fsName)===$._sfx._normPath(f.fsName)){itemAE=pi;break;}}catch(e4){}
            }
            if(!itemAE){ var io=new ImportOptions(f); itemAE=app.project.importFile(io); }
            stage='AE add layer';
            var layer=comp.layers.add(itemAE); layer.startTime=comp.time;
            return 'Added to After Effects · current time';
        }

        return 'ADD error: unsupported Adobe host · '+host;
    } catch(e){
        var detail=''; try{ detail=' · line '+e.line; }catch(ignore){}
        return 'ADD error ['+stage+']: '+e.toString()+detail;
    }
};
