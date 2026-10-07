(function(){
  var cs=new CSInterface();
  var fs=require('fs'), path=require('path');
  var rootsEl=document.getElementById('roots'), empty=document.getElementById('empty'), audio=document.getElementById('audio'), status=document.getElementById('status');
  var inspector=document.getElementById('inspector'), canvas=document.getElementById('waveform'), ctx=canvas.getContext('2d'), waveEmpty=document.getElementById('waveEmpty');
  var addBtn=document.getElementById('addToTimeline'), notesEl=document.getElementById('notes');
  var previewPlayhead=document.getElementById('previewPlayhead');
  var previewObjectURL=null, previewToken=0, playheadRAF=0;
  var wavContext=null, wavSource=null, wavGain=null, wavStartedAt=0, wavDuration=0, wavPlaying=false;
  var volume=document.getElementById('volume'), volumeValue=document.getElementById('volumeValue');
  var exts={'.wav':1,'.mp3':1,'.aif':1,'.aiff':1,'.m4a':1,'.aac':1,'.flac':1,'.ogg':1};
  function loadList(key){
    var raw=null, value=[];
    try{raw=localStorage.getItem(key); value=raw?JSON.parse(raw):[];}catch(e){value=[];}
    if(Array.isArray(value)) return value.filter(function(x){return typeof x==='string'&&x.length;});
    // Migration for older builds that may have stored favorites/hidden items as an object.
    if(value&&typeof value==='object'){
      var out=[];
      Object.keys(value).forEach(function(k){
        if(typeof value[k]==='string'&&value[k].length) out.push(value[k]);
        else if(value[k]===true&&k) out.push(k);
      });
      return out;
    }
    if(typeof value==='string'&&value.length) return [value];
    return [];
  }
  var roots=loadList('sfxRoots');
  var hidden=loadList('sfxHidden');
  var favorites=loadList('sfxFavorites');
  var expandedFolders=loadList('sfxExpandedFolders');
  var hadExpandedState=localStorage.getItem('sfxExpandedFolders')!==null;
  if(!hadExpandedState) expandedFolders=roots.slice();
  // Persist normalized data immediately so future launches use one stable format.
  try{localStorage.setItem('sfxRoots',JSON.stringify(roots));localStorage.setItem('sfxHidden',JSON.stringify(hidden));localStorage.setItem('sfxFavorites',JSON.stringify(favorites));localStorage.setItem('sfxExpandedFolders',JSON.stringify(expandedFolders));}catch(e){}
  var selectedPath=null, selectedWrap=null, noteTimer=null, favoritesMode=false;
  try{audio.volume=Math.max(0,Math.min(1,(parseInt(localStorage.getItem('sfxPreviewVolume')||'85',10)/100))); volume.value=Math.round(audio.volume*100)}catch(e){}
  volumeValue.textContent=volume.value+'%';

  function save(){localStorage.setItem('sfxRoots',JSON.stringify(roots))}
  function saveHidden(){localStorage.setItem('sfxHidden',JSON.stringify(hidden))}
  function saveFavorites(){localStorage.setItem('sfxFavorites',JSON.stringify(favorites))}
  function saveExpanded(){localStorage.setItem('sfxExpandedFolders',JSON.stringify(expandedFolders))}
  function isExpanded(p){return expandedFolders.indexOf(p)>=0}
  function setExpanded(p,on){expandedFolders=expandedFolders.filter(function(x){return x!==p});if(on)expandedFolders.push(p);saveExpanded()}
  function captureExpandedState(){var open=[];document.querySelectorAll('.folder.open').forEach(function(el){if(el.dataset&&el.dataset.path)open.push(el.dataset.path)});if(open.length||document.querySelectorAll('.folder').length){expandedFolders=open;saveExpanded()}}
  function isHidden(p){return Array.isArray(hidden)&&hidden.indexOf(p)>=0}
  function isFavorite(p){return Array.isArray(favorites)&&favorites.indexOf(p)>=0}
  function refreshFavoriteUI(p){
    var on=isFavorite(p);
    document.querySelectorAll('.file').forEach(function(fileEl){
      if(!fileEl.dataset||fileEl.dataset.path!==p)return;
      var star=fileEl.querySelector('.rowStar');
      if(!star)return;
      star.classList.toggle('on',on);
      star.textContent=on?'★':'☆';
      star.title=on?'Remove from favorites':'Add to favorites';
    });
  }
  function toggleFavorite(p){
    if(!p)return;
    if(!Array.isArray(favorites)) favorites=[];
    var wasFavorite=isFavorite(p);
    if(wasFavorite) favorites=favorites.filter(function(x){return x!==p});
    else favorites.push(p);
    saveFavorites();
    if(favoritesMode){
      // Favorites is a filtered view, so removing an item must make its row disappear immediately.
      renderFavorites();
    }else{
      // Do not rebuild the folder tree just to flip a star: this keeps open folders and selection intact.
      refreshFavoriteUI(p);
    }
    status.textContent=(isFavorite(p)?'Added to favorites: ':'Removed from favorites: ')+displayName(p);
  }
  function hideItem(p){captureExpandedState();if(hidden.indexOf(p)<0){hidden.push(p);saveHidden()}clearSelectionIfUnder(p);render();status.textContent='Hidden: '+path.basename(p)}
  function restoreItem(p){captureExpandedState();hidden=hidden.filter(function(x){return x!==p});saveHidden();render();renderHidden();status.textContent='Restored: '+path.basename(p)}
  function esc(s){return String(s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
  function fileURL(p){var u=p.replace(/\\/g,'/'); if(u[0]!='/')u='/'+u; return encodeURI('file://'+u)}
  function list(dir){try{return fs.readdirSync(dir).map(function(n){var p=path.join(dir,n),st;try{st=fs.statSync(p)}catch(e){return null}return {name:n,path:p,dir:st.isDirectory()}}).filter(Boolean).filter(function(x){return !isHidden(x.path)&&(x.dir||exts[path.extname(x.name).toLowerCase()])}).sort(function(a,b){if(a.dir!==b.dir)return a.dir?-1:1;return a.name.localeCompare(b.name,undefined,{numeric:true})})}catch(e){return []}}
  function noteKey(p){return 'sfxNote::'+p}
  function fmtBytes(n){if(!isFinite(n))return '—';var u=['B','KB','MB','GB'],i=0;while(n>=1024&&i<u.length-1){n/=1024;i++}return (i? n.toFixed(n>=10?1:2):Math.round(n))+' '+u[i]}
  function fmtTime(sec){if(!isFinite(sec))return '—';var m=Math.floor(sec/60),s=sec-m*60;return (m?m+':':'')+(m&&s<10?'0':'')+s.toFixed(2)}
  function clearSelectionIfUnder(target){if(selectedPath&&(selectedPath===target||selectedPath.indexOf(target+path.sep)===0)){audio.pause();selectedPath=null;selectedWrap=null;document.querySelectorAll('.file.selected,.file.playing').forEach(function(x){x.classList.remove('selected');x.classList.remove('playing')});inspector.classList.add('disabled');addBtn.disabled=true;notesEl.disabled=true;notesEl.value='';document.getElementById('infoName').textContent='—';document.getElementById('infoFormat').textContent='—';document.getElementById('infoDuration').textContent='—';document.getElementById('infoSize').textContent='—';document.getElementById('infoAudio').textContent='—';document.getElementById('infoPath').textContent='—';waveEmpty.textContent='Select a sound';waveEmpty.style.display='flex';resetWave()}}
  function removeRoot(p){captureExpandedState();roots=roots.filter(function(r){return r!==p});expandedFolders=expandedFolders.filter(function(x){return x!==p&&x.indexOf(p+path.sep)!==0});save();saveExpanded();clearSelectionIfUnder(p);render();status.textContent='Folder removed from browser'}
  function hideMenu(){var m=document.getElementById('contextMenu');if(m)m.style.display='none'}
  function showMenu(x,y,item,isRoot){
    var m=document.getElementById('contextMenu');m.innerHTML='';
    function action(text,fn){var b=document.createElement('button');b.textContent=text;b.onclick=function(e){e.stopPropagation();hideMenu();fn()};m.appendChild(b)}
    if(!item.dir) action(isFavorite(item.path)?'Remove from favorites':'Add to favorites',function(){toggleFavorite(item.path)});
    action(item.dir?'Hide folder':'Hide sound',function(){hideItem(item.path)});
    if(item.dir&&isRoot)action('Remove root from browser',function(){removeRoot(item.path)});
    m.style.display='block';
    var r=m.getBoundingClientRect(),left=Math.min(x,window.innerWidth-r.width-6),top=Math.min(y,window.innerHeight-r.height-6);m.style.left=Math.max(6,left)+'px';m.style.top=Math.max(6,top)+'px';
  }
  function renderHidden(){
    var panel=document.getElementById('hiddenPanel'),listEl=document.getElementById('hiddenList');
    if(!panel||!listEl)return; listEl.innerHTML='';
    if(!hidden.length){listEl.innerHTML='<div class="hiddenEmpty">No hidden items</div>';return}
    hidden.slice().sort().forEach(function(p){var row=document.createElement('div');row.className='hiddenRow';var name=document.createElement('span');name.textContent=(exts[path.extname(p).toLowerCase()]?displayName(p):(path.basename(p)||p));name.title=p;var b=document.createElement('button');b.textContent='Restore';b.onclick=function(){restoreItem(p)};row.appendChild(name);row.appendChild(b);listEl.appendChild(row)})
  }
  function resetWave(){ctx.clearRect(0,0,canvas.width,canvas.height);ctx.fillStyle='#050505';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.strokeStyle='#303030';ctx.beginPath();ctx.moveTo(0,canvas.height/2+.5);ctx.lineTo(canvas.width,canvas.height/2+.5);ctx.stroke()}
  function drawWave(buffer){resetWave();var data=buffer.getChannelData(0),w=canvas.width,h=canvas.height,mid=h/2,step=Math.max(1,Math.ceil(data.length/w));ctx.strokeStyle='#e7e7e7';ctx.lineWidth=1;ctx.beginPath();for(var x=0;x<w;x++){var start=x*step,end=Math.min(start+step,data.length),min=1,max=-1;for(var j=start;j<end;j++){var v=data[j];if(v<min)min=v;if(v>max)max=v}var y1=mid+min*mid*.88,y2=mid+max*mid*.88;ctx.moveTo(x+.5,y1);ctx.lineTo(x+.5,y2)}ctx.stroke()}
  function decodeForWave(p){
    waveEmpty.style.display='none';resetWave();
    fs.readFile(p,function(err,buf){
      if(err){waveEmpty.textContent='Waveform unavailable';waveEmpty.style.display='flex';return}
      var AC=window.AudioContext||window.webkitAudioContext;if(!AC){waveEmpty.textContent='Waveform unavailable';waveEmpty.style.display='flex';return}
      var ac=new AC();
      if(path.extname(p).toLowerCase()==='.wav'){try{var decodedWav=decodeWavBuffer(buf,ac);drawWave(decodedWav);document.getElementById('infoDuration').textContent=fmtTime(decodedWav.duration);document.getElementById('infoAudio').textContent=Math.round(decodedWav.sampleRate/100)/10+' kHz · '+decodedWav.numberOfChannels+' ch';try{ac.close()}catch(e){}return}catch(e){}}
      try{var arr=buf.buffer.slice(buf.byteOffset,buf.byteOffset+buf.byteLength);ac.decodeAudioData(arr,function(decoded){drawWave(decoded);document.getElementById('infoDuration').textContent=fmtTime(decoded.duration);document.getElementById('infoAudio').textContent=Math.round(decoded.sampleRate/100)/10+' kHz · '+decoded.numberOfChannels+' ch';try{ac.close()}catch(e){}},function(){waveEmpty.textContent='Waveform unavailable for this format';waveEmpty.style.display='flex';try{ac.close()}catch(e){}})}catch(e){waveEmpty.textContent='Waveform unavailable';waveEmpty.style.display='flex';try{ac.close()}catch(x){}}
    });
  }
  function displayName(p){var base=path.basename(p);var ext=path.extname(base);return ext?base.slice(0,-ext.length):base}
  function selectFile(p,wrap,play){selectedPath=p;selectedWrap=wrap;document.querySelectorAll('.file.selected').forEach(function(x){x.classList.remove('selected')});if(wrap)wrap.classList.add('selected');inspector.classList.remove('disabled');addBtn.disabled=false;notesEl.disabled=false;notesEl.value=localStorage.getItem(noteKey(p))||'';var st=null;try{st=fs.statSync(p)}catch(e){}document.getElementById('infoName').textContent=displayName(p);document.getElementById('infoFormat').textContent=(path.extname(p).replace('.','').toUpperCase()||'—');document.getElementById('infoDuration').textContent='…';document.getElementById('infoSize').textContent=st?fmtBytes(st.size):'—';document.getElementById('infoAudio').textContent='…';document.getElementById('infoPath').textContent=p;decodeForWave(p);if(play)preview(p,wrap)}
  function fileRowHTML(item){
    var ext=path.extname(item.name).replace('.','').toUpperCase();
    return '<span class="caret"></span><span class="audioIcon">'+esc(ext||'SFX')+'</span><span class="name">'+esc(displayName(item.name))+'</span><button class="rowStar '+(isFavorite(item.path)?'on':'')+'" title="'+(isFavorite(item.path)?'Remove from favorites':'Add to favorites')+'">'+(isFavorite(item.path)?'★':'☆')+'</button>';
  }
  function node(item,depth,isRoot){
    var initiallyOpen=item.dir&&isExpanded(item.path);
    var wrap=document.createElement('div'); wrap.className='node '+(item.dir?'folder':'file')+(isRoot?' root':'')+(initiallyOpen?' open':''); wrap.dataset.path=item.path;
    var row=document.createElement('div'); row.className='row'; row.style.paddingLeft=(6+depth*14)+'px';
    if(item.dir){
      row.innerHTML='<span class="caret">›</span><span class="folderIcon"></span><span class="name">'+esc(item.name)+'</span>'+(isRoot?'<button class="remove" title="Remove root folder">×</button>':'');
      var ch=document.createElement('div');ch.className='children';wrap.appendChild(row);wrap.appendChild(ch);var loaded=false;
      function loadChildren(){if(!loaded){loaded=true;list(item.path).forEach(function(x){ch.appendChild(node(x,depth+1,false))})}}
      function open(){var next=!wrap.classList.contains('open');wrap.classList.toggle('open',next);setExpanded(item.path,next);if(next)loadChildren()}
      row.addEventListener('click',function(e){if(e.target.classList.contains('remove'))return;open()});
      if(initiallyOpen)loadChildren();
      if(isRoot){row.querySelector('.remove').onclick=function(e){e.stopPropagation();removeRoot(item.path)}}
    }else{
      row.innerHTML=fileRowHTML(item); row.draggable=true; wrap.appendChild(row);
      row.addEventListener('click',function(e){if(e.target.classList.contains('rowStar'))return;selectFile(item.path,wrap,true)});
      // Double click deliberately does NOT insert. ADD is the only timeline insertion control.
      row.addEventListener('dblclick',function(e){if(e.target.classList.contains('rowStar'))return;selectFile(item.path,wrap,true)});
      row.querySelector('.rowStar').onclick=function(e){e.stopPropagation();toggleFavorite(item.path)};
      row.addEventListener('dragstart',function(e){selectFile(item.path,wrap,false);try{e.dataTransfer.effectAllowed='copy';e.dataTransfer.setData('com.adobe.cep.dnd.file.0',item.path);e.dataTransfer.setData('text/uri-list',fileURL(item.path));e.dataTransfer.setData('text/plain',item.path);status.textContent='Drag: '+path.basename(item.path)}catch(err){status.textContent='Drag error: '+err.toString()}});
      row.addEventListener('dragend',function(){status.textContent='Ready'}); row.tabIndex=0;
    }
    row.addEventListener('contextmenu',function(e){e.preventDefault();e.stopPropagation();if(!item.dir)selectFile(item.path,wrap,false);showMenu(e.clientX,e.clientY,item,isRoot)});
    return wrap;
  }
  function renderFavorites(){
    rootsEl.innerHTML='';
    var valid=favorites.filter(function(p){return !isHidden(p)&&fs.existsSync(p)&&exts[path.extname(p).toLowerCase()]});
    empty.style.display=valid.length?'none':'flex';
    if(!valid.length){empty.innerHTML='No favorites yet<br><small>Use ☆ next to any sound to add it here.</small>';return}
    valid.sort(function(a,b){return path.basename(a).localeCompare(path.basename(b),undefined,{numeric:true})}).forEach(function(p){rootsEl.appendChild(node({name:path.basename(p),path:p,dir:false},0,false))});
  }
  function render(){
    var mb=document.getElementById('modeBanner'), ft=document.getElementById('favoritesToggle');
    if(mb) mb.style.display=favoritesMode?'flex':'none';
    if(ft&&ft.classList){ if(favoritesMode) ft.classList.add('active'); else ft.classList.remove('active'); }
    if(favoritesMode){renderFavorites();return}
    rootsEl.innerHTML=''; empty.innerHTML='Add your SFX folder with ＋<br><small>Your folder names and structure stay exactly as they are.</small>'; empty.style.display=roots.length?'none':'flex';
    roots.forEach(function(p){if(fs.existsSync(p)&&!isHidden(p))rootsEl.appendChild(node({name:path.basename(p)||p,path:p,dir:true},0,true))})
  }
  function mimeFor(p){var e=path.extname(p).toLowerCase();return {'.wav':'audio/wav','.mp3':'audio/mpeg','.aif':'audio/aiff','.aiff':'audio/aiff','.m4a':'audio/mp4','.aac':'audio/aac','.flac':'audio/flac','.ogg':'audio/ogg'}[e]||'application/octet-stream'}
  function clearPreviewURL(){if(previewObjectURL){try{(window.URL||window.webkitURL).revokeObjectURL(previewObjectURL)}catch(e){}previewObjectURL=null}}
  function stopWavPreview(){
    wavPlaying=false;
    if(wavSource){try{wavSource.onended=null;wavSource.stop(0)}catch(e){}try{wavSource.disconnect()}catch(e){}wavSource=null}
    if(wavGain){try{wavGain.disconnect()}catch(e){}wavGain=null}
  }
  function resetPreviewPlayhead(){if(playheadRAF){cancelAnimationFrame(playheadRAF);playheadRAF=0}if(previewPlayhead){previewPlayhead.style.left='0%';previewPlayhead.style.display='none'}}
  function animatePreviewPlayhead(){
    if(!previewPlayhead)return;
    var d,t;
    if(wavPlaying&&wavContext){d=wavDuration;t=wavContext.currentTime-wavStartedAt}else{d=Number(audio.duration);t=Number(audio.currentTime)}
    if(isFinite(d)&&d>0&&isFinite(t)){previewPlayhead.style.display='block';previewPlayhead.style.left=(Math.max(0,Math.min(1,t/d))*100)+'%'}
    var stillPlaying=wavPlaying||(!audio.paused&&!audio.ended);
    if(stillPlaying)playheadRAF=requestAnimationFrame(animatePreviewPlayhead);else playheadRAF=0;
  }
  function readFourCC(view,o){return String.fromCharCode(view.getUint8(o),view.getUint8(o+1),view.getUint8(o+2),view.getUint8(o+3))}
  function decodeMuLaw(v){v=(~v)&255;var t=((v&15)<<3)+132;t<<=(v&112)>>4;return ((v&128)?(132-t):(t-132))/32768}
  function decodeALaw(v){v^=0x55;var t=(v&15)<<4;var seg=(v&112)>>4;if(seg===0)t+=8;else if(seg===1)t+=0x108;else{t+=0x108;t<<=(seg-1)}return ((v&128)?t:-t)/32768}
  function decodeWavBuffer(nodeBuf,ac){
    var ab=nodeBuf.buffer.slice(nodeBuf.byteOffset,nodeBuf.byteOffset+nodeBuf.byteLength),v=new DataView(ab);
    if(v.byteLength<44||readFourCC(v,0)!=='RIFF'||readFourCC(v,8)!=='WAVE')throw new Error('Not a RIFF/WAVE file');
    var off=12,fmt=null,dataOff=-1,dataSize=0;
    while(off+8<=v.byteLength){var id=readFourCC(v,off),sz=v.getUint32(off+4,true),body=off+8;if(id==='fmt '){fmt={off:body,size:sz}}else if(id==='data'){dataOff=body;dataSize=Math.min(sz,v.byteLength-body)}off=body+sz+(sz&1)}
    if(!fmt||dataOff<0)throw new Error('WAV has no fmt/data chunk');
    var fo=fmt.off,tag=v.getUint16(fo,true),channels=v.getUint16(fo+2,true),rate=v.getUint32(fo+4,true),blockAlign=v.getUint16(fo+12,true),bits=v.getUint16(fo+14,true);
    if(tag===0xfffe&&fmt.size>=40){tag=v.getUint16(fo+24,true)}
    if(!channels||!rate||!blockAlign)throw new Error('Invalid WAV format');
    var frames=Math.floor(dataSize/blockAlign),out=ac.createBuffer(channels,frames,rate),arrays=[],c,i,pos,sample;for(c=0;c<channels;c++)arrays[c]=out.getChannelData(c);
    function clamp(x){return x>1?1:(x<-1?-1:x)}
    if(tag===1||tag===3){
      var bytes=bits>>3;if(!bytes)throw new Error('Invalid bit depth');
      for(i=0;i<frames;i++){for(c=0;c<channels;c++){pos=dataOff+i*blockAlign+c*bytes;if(pos+bytes>v.byteLength){sample=0}else if(tag===3){if(bits===32)sample=v.getFloat32(pos,true);else if(bits===64)sample=v.getFloat64(pos,true);else throw new Error('Unsupported IEEE float depth '+bits)}else{if(bits===8)sample=(v.getUint8(pos)-128)/128;else if(bits===16)sample=v.getInt16(pos,true)/32768;else if(bits===24){var n=v.getUint8(pos)|(v.getUint8(pos+1)<<8)|(v.getUint8(pos+2)<<16);if(n&0x800000)n|=0xff000000;sample=n/8388608}else if(bits===32)sample=v.getInt32(pos,true)/2147483648;else throw new Error('Unsupported PCM depth '+bits)}arrays[c][i]=clamp(sample)}}
    }else if(tag===6||tag===7){
      for(i=0;i<frames;i++){for(c=0;c<channels;c++){pos=dataOff+i*blockAlign+c;sample=tag===6?decodeALaw(v.getUint8(pos)):decodeMuLaw(v.getUint8(pos));arrays[c][i]=sample}}
    }else{var e=new Error('Unsupported WAV codec 0x'+tag.toString(16));e.wavTag=tag;throw e}
    out._sfxFormatTag=tag;return out
  }
  function playDecodedWav(buf,p,wrap,token){
    if(token!==previewToken)return;
    var AC=window.AudioContext||window.webkitAudioContext;if(!AC)throw new Error('AudioContext unavailable');
    if(!wavContext)wavContext=new AC();
    var decoded=decodeWavBuffer(buf,wavContext);stopWavPreview();
    wavSource=wavContext.createBufferSource();wavGain=wavContext.createGain();wavGain.gain.value=parseInt(volume.value,10)/100;wavSource.buffer=decoded;wavSource.connect(wavGain);wavGain.connect(wavContext.destination);
    wavDuration=decoded.duration;wavStartedAt=wavContext.currentTime;wavPlaying=true;audio.dataset.path=p;
    drawWave(decoded);document.getElementById('infoDuration').textContent=fmtTime(decoded.duration);document.getElementById('infoAudio').textContent=Math.round(decoded.sampleRate/100)/10+' kHz · '+decoded.numberOfChannels+' ch';
    if(wrap)wrap.classList.add('playing');resetPreviewPlayhead();animatePreviewPlayhead();status.textContent='Preview: '+path.basename(p);
    wavSource.onended=function(){if(token!==previewToken)return;wavPlaying=false;if(wrap)wrap.classList.remove('playing');if(previewPlayhead){previewPlayhead.style.display='block';previewPlayhead.style.left='100%'}};
    wavSource.start(0);
  }
  function startAudioURL(src,p,wrap,token,onFail){
    if(token!==previewToken)return;
    audio.pause();audio.src=src;audio.dataset.path=p;audio.load();
    if(wrap)wrap.classList.add('playing');
    var settled=false;
    function fail(){if(settled||token!==previewToken)return;settled=true;if(wrap)wrap.classList.remove('playing');if(onFail)onFail()}
    function go(){
      if(token!==previewToken)return;
      var pr;try{pr=audio.play()}catch(e){fail();return}
      if(pr&&typeof pr.then==='function')pr.then(function(){if(token!==previewToken)return;settled=true;status.textContent='Preview: '+path.basename(p);resetPreviewPlayhead();animatePreviewPlayhead()}).catch(fail);
      else{settled=true;status.textContent='Preview: '+path.basename(p);resetPreviewPlayhead();animatePreviewPlayhead()}
    }
    var timer=setTimeout(function(){if(!settled&&audio.readyState<2)fail()},1800);
    audio.oncanplay=function(){clearTimeout(timer);go()};
    audio.onerror=function(){clearTimeout(timer);fail()};
  }
  function preview(p,wrap){
    var token=++previewToken;
    document.querySelectorAll('.file.playing').forEach(function(x){x.classList.remove('playing')});
    audio.pause();stopWavPreview();resetPreviewPlayhead();clearPreviewURL();audio.removeAttribute('src');try{audio.load()}catch(e){}
    audio.dataset.path=p;if(wrap)wrap.classList.add('playing');status.textContent='Loading preview: '+path.basename(p);
    fs.readFile(p,function(err,buf){
      if(token!==previewToken)return;
      if(err){if(wrap)wrap.classList.remove('playing');status.textContent='Could not read file: '+path.basename(p);return}
      if(path.extname(p).toLowerCase()==='.wav'){
        try{playDecodedWav(buf,p,wrap,token);return}catch(wavErr){
          // Some WAV containers use compressed codecs. Give Chromium one chance before reporting the codec.
          try{var bytes=new Uint8Array(buf.length);for(var wi=0;wi<buf.length;wi++)bytes[wi]=buf[wi];previewObjectURL=(window.URL||window.webkitURL).createObjectURL(new Blob([bytes],{type:'audio/wav'}));startAudioURL(previewObjectURL,p,wrap,token,function(){if(wrap)wrap.classList.remove('playing');status.textContent='Could not preview WAV: '+wavErr.message})}catch(blobErr){if(wrap)wrap.classList.remove('playing');status.textContent='Could not preview WAV: '+wavErr.message}
          return;
        }
      }
      try{
        var bytes2=new Uint8Array(buf.length);for(var j=0;j<buf.length;j++)bytes2[j]=buf[j];
        previewObjectURL=(window.URL||window.webkitURL).createObjectURL(new Blob([bytes2],{type:mimeFor(p)}));
        startAudioURL(previewObjectURL,p,wrap,token,function(){clearPreviewURL();startAudioURL(fileURL(p),p,wrap,token,function(){if(wrap)wrap.classList.remove('playing');status.textContent='Could not preview file: '+path.basename(p)})});
      }catch(e){startAudioURL(fileURL(p),p,wrap,token,function(){if(wrap)wrap.classList.remove('playing');status.textContent='Could not preview file: '+path.basename(p)})}
    });
  }
  audio.addEventListener('loadedmetadata',function(){if(selectedPath&&audio.dataset.path===selectedPath&&isFinite(audio.duration))document.getElementById('infoDuration').textContent=fmtTime(audio.duration)});
  audio.addEventListener('play',function(){resetPreviewPlayhead();animatePreviewPlayhead()});
  audio.addEventListener('pause',function(){if(playheadRAF){cancelAnimationFrame(playheadRAF);playheadRAF=0}});
  audio.addEventListener('ended',function(){document.querySelectorAll('.file.playing').forEach(function(x){x.classList.remove('playing')});if(previewPlayhead){previewPlayhead.style.display='block';previewPlayhead.style.left='100%'}});
  function insert(p){if(!p)return;status.textContent='ADD: '+path.basename(p);var arg=JSON.stringify(p);var dur=(wavPlaying&&audio.dataset.path===p&&wavDuration>0)?wavDuration:((audio&&audio.dataset.path===p&&isFinite(audio.duration))?Number(audio.duration):0);cs.evalScript('$._sfx.insert('+arg+','+dur+')',function(r){status.textContent=(r&&r!=='undefined')?r:'ADD failed: no response from Premiere'})}
  addBtn.onclick=function(){insert(selectedPath)};
  document.getElementById('stop').onclick=function(){++previewToken;audio.pause();try{audio.currentTime=0}catch(e){}stopWavPreview();resetPreviewPlayhead();clearPreviewURL();document.querySelectorAll('.file.playing').forEach(function(x){x.classList.remove('playing')});status.textContent='Stopped'};
  document.getElementById('addFolder').onclick=function(){var r=window.cep.fs.showOpenDialogEx(false,true,'Choose an SFX folder');if(r&&r.data&&r.data.length){var p=r.data[0];if(roots.indexOf(p)<0){captureExpandedState();roots.push(p);setExpanded(p,true);save();render()}}};
  document.getElementById('search').addEventListener('input',function(){var q=this.value.trim().toLowerCase();document.querySelectorAll('.file').forEach(function(el){el.style.display=!q||path.basename(el.dataset.path).toLowerCase().indexOf(q)>=0?'':'none'});if(q&&!favoritesMode)document.querySelectorAll('.folder').forEach(function(el){el.classList.add('open')})});
  volume.addEventListener('input',function(){audio.volume=parseInt(this.value,10)/100;if(wavGain)wavGain.gain.value=parseInt(this.value,10)/100;volumeValue.textContent=this.value+'%';localStorage.setItem('sfxPreviewVolume',this.value)});
  notesEl.addEventListener('input',function(){clearTimeout(noteTimer);var p=selectedPath,v=this.value;noteTimer=setTimeout(function(){if(p)localStorage.setItem(noteKey(p),v)},220)});
  window.addEventListener('keydown',function(e){if(e.key==='Escape')hideMenu()});
  window.addEventListener('mousedown',function(e){var m=document.getElementById('contextMenu');if(m&&m.style.display!=='none'&&!m.contains(e.target))hideMenu()});
  window.addEventListener('blur',hideMenu);
  window.addEventListener('unload',function(){try{audio.pause()}catch(e){}stopWavPreview();try{if(wavContext)wavContext.close()}catch(e){}resetPreviewPlayhead();clearPreviewURL()});
  document.getElementById('hiddenToggle').onclick=function(){var p=document.getElementById('hiddenPanel');var show=p.style.display!=='block';p.style.display=show?'block':'none';if(show)renderHidden()};
  document.getElementById('hiddenClose').onclick=function(){document.getElementById('hiddenPanel').style.display='none'};

  window.onerror=function(message,source,line,column,error){
    try{status.textContent='JS error: '+message+(line?' · line '+line:'');}catch(e){}
    return false;
  };
  var favToggle=document.getElementById('favoritesToggle'), favClose=document.getElementById('favoritesClose');
  if(favToggle) favToggle.onclick=function(){favoritesMode=!favoritesMode;render()};
  if(favClose) favClose.onclick=function(){favoritesMode=false;render()};
  // Render the library first. Optional UI features must never be able to hide the sound list.
  resetWave();
  try{ render(); }catch(renderErr){ status.textContent='Browser render error: '+renderErr.toString(); }
  try{ renderHidden(); }catch(hiddenErr){}
})();
