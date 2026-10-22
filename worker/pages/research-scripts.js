// Inline `<script>` blocks for the research report page: always-on page
// behavior (copy-link, image-fallback swap, native share), the processing-page
// activity feed poller, the email-subscribe wiring, and the "talk about it"
// chat/refine widget. Split out of research-page.js verbatim so that file
// stays under the file-size cap. Each export keeps the same
// `nonce="__CSP_NONCE__"` attribute and `JSON.stringify(...)` embedding as the
// original inline template strings.

// Always-on wiring: copy-link buttons + image fallback swap on error. These
// replace the old inline onclick/onerror handlers that nonce-based CSP
// refuses to execute. Zero interpolation, so it takes no arguments.
export function pageBehaviorScript() {
  return `<script nonce="__CSP_NONCE__">
(function(){
  function wireCopy(){
    document.querySelectorAll('.js-copy-link').forEach(function(btn){
      if(btn.__wired)return;btn.__wired=true;
      var original=btn.innerHTML;
      btn.addEventListener('click',function(){
        var url=btn.dataset.url||'';
        if(!url||!navigator.clipboard)return;
        navigator.clipboard.writeText(url).then(function(){
          btn.textContent='Copied!';
          setTimeout(function(){btn.innerHTML=original},2000);
        });
      });
    });
  }
  function wireImages(){
    document.querySelectorAll('.item-image-photo').forEach(function(img){
      if(img.__wired)return;img.__wired=true;
      img.addEventListener('error',function(){
        img.hidden=true;
        var fb=img.nextElementSibling;
        if(fb&&fb.classList.contains('item-image-fallback'))fb.style.display='flex';
      });
    });
  }
  function wireNativeShare(){
    if(!navigator.share)return;
    document.querySelectorAll('.js-native-share').forEach(function(btn){
      if(btn.__wired)return;btn.__wired=true;
      btn.style.display='';
      btn.addEventListener('click',function(){
        navigator.share({title:document.title,url:btn.dataset.url||location.href}).catch(function(){});
      });
    });
  }
  function run(){wireCopy();wireNativeShare();wireImages()}
  if(document.readyState==='loading'){document.addEventListener('DOMContentLoaded',run)}else{run()}
  // Expose for post-swap rewiring after the activity feed completes a research.
  window.__rewire=run;
})();
</script>`;
}

// Processing-page poller: streams /api/research/:slug/events into the
// activity feed and swaps the page in-place once the run completes.
export function activityFeedScript(slug) {
  return `<noscript><meta http-equiv="refresh" content="10"></noscript>
<script nonce="__CSP_NONCE__">
document.addEventListener('DOMContentLoaded',function(){
  var feed=document.getElementById('activity-feed');
  var counter=document.getElementById('source-count');
  if(!feed)return;
  var slug=${JSON.stringify(slug).replace(/</g,'\\u003c')};
  var lastSeq=0;
  var sources=0;
  var pollCount=0;
  var failCount=0;
  var icons={search:'\u{1F50D}',fetch:'\u{1F4D6}',note:'\u{1F4DD}',synthesize:'\u{2728}',status:'\u{2139}\uFE0F',error:'\u{26A0}\uFE0F'};
  var STEP_OF={search:0,fetch:1,note:2,synthesize:3};var maxStep=0;
  function updateSteps(cur){var steps=document.querySelectorAll('#progress-steps .progress-step');for(var i=0;i<steps.length;i++){var s=parseInt(steps[i].dataset.step,10);steps[i].classList.toggle('is-done',s<cur);steps[i].classList.toggle('is-active',s===cur);}}
  function poll(){
    pollCount++;
    fetch('/api/research/'+slug+'/events?since='+lastSeq)
      .then(function(r){var ct=r.headers.get('content-type')||'';if(ct.indexOf('application/json')===-1){throw new Error('non-json')}return r.json()})
      .then(function(d){
        failCount=0;
        if(d.preview){
          var box=document.getElementById('preview-box');
          var txt=document.getElementById('preview-text');
          if(box&&txt&&box.style.display==='none'){
            txt.textContent=d.preview;
            box.style.display='block';
          }
        }
        if(d.events&&d.events.length>0){
          d.events.forEach(function(e){
            var div=document.createElement('div');
            div.className='activity-item activity-'+e.event_type;
            div.textContent=(icons[e.event_type]||'\u{25CF}')+' '+e.message;
            feed.appendChild(div);
            feed.scrollTop=feed.scrollHeight;
            lastSeq=e.seq;
            if(e.event_type==='search')sources++;
            if(e.event_type in STEP_OF){var st=STEP_OF[e.event_type];if(st>maxStep){maxStep=st;updateSteps(maxStep);}}
          });
          if(counter)counter.textContent=sources+' searches completed';
        }
        if(d.status==='complete'){
          maxStep=3;updateSteps(3);
          // In-place swap: fetch the now-rendered page, splice in .container content.
          // Falls back to reload if anything goes wrong. Also re-wires inline
          // handlers on the freshly-inserted DOM via window.__rewire.
          fetch(location.pathname,{cache:'no-store'})
            .then(function(r){return r.text()})
            .then(function(html){
              try{
                var parser=new DOMParser();
                var doc=parser.parseFromString(html,'text/html');
                var fresh=doc.querySelector('.container');
                var current=document.querySelector('.container');
                if(fresh&&current){
                  current.replaceWith(fresh);
                  document.title=doc.title;
                  if(typeof window.__rewire==='function')window.__rewire();
                  window.scrollTo({top:0,behavior:'smooth'});
                }else{location.reload()}
              }catch(e){location.reload()}
            })
            .catch(function(){location.reload()});
        }else if(d.status==='failed'){
          var div=document.createElement('div');
          div.className='activity-item activity-error';
          div.textContent='\u{26A0}\uFE0F Research failed. Reloading...';
          feed.appendChild(div);
          setTimeout(function(){location.reload()},2000);
        }else{
          setTimeout(poll,pollCount<3?500:1000);
        }
      })
      .catch(function(){
        failCount++;
        if(failCount>10){
          if(counter)counter.textContent='Connection lost — refresh to continue.';
          var div=document.createElement('div');
          div.className='activity-item activity-error';
          div.textContent='\u{26A0}️ Connection lost — refresh to continue.';
          feed.appendChild(div);
          return;
        }
        setTimeout(poll,3000);
      });
  }
  poll();
});
</script>`;
}

// Email capture: wires whichever #notify-form is on the page (the compact box
// on processing pages, or the footer form on completed pages) to POST
// /api/subscribe. researchId is the report id so we can notify on re-research.
export function subscribeScript(researchId = null) {
  return `<script nonce="__CSP_NONCE__">
(function(){
  function wire(){
    var form=document.getElementById('notify-form');
    if(!form||form.__wired)return;form.__wired=true;
    var input=document.getElementById('notify-email');
    var msg=document.getElementById('notify-msg');
    var researchId=${JSON.stringify(researchId).replace(/</g,'\\u003c')};
    form.addEventListener('submit',function(ev){
      ev.preventDefault();
      var email=(input&&input.value||'').trim();
      if(!email)return;
      if(msg)msg.textContent='Saving...';
      fetch('/api/subscribe',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({email:email,researchId:researchId})
      }).then(function(r){var ct=r.headers.get('content-type')||'';if(ct.indexOf('application/json')===-1){throw new Error('non-json')}return r.json()}).then(function(d){
        if(d&&d.ok){
          if(msg)msg.textContent=d.mail==='off'?'Email is not switched on yet, so we cannot send you anything. Please try again later.':'Check your inbox and click the link to confirm.';
          form.style.display='none';
        }else{
          if(msg)msg.textContent='That email looks off. Try again?';
        }
      }).catch(function(){
        if(msg)msg.textContent='Something went wrong. Try again later.';
      });
    });
  }
  if(document.readyState==='loading'){document.addEventListener('DOMContentLoaded',wire)}else{wire()}
  // Re-wire the footer form that appears after the processing->complete in-place
  // swap (window.__rewire is defined by the page behavior script above).
  var prev=window.__rewire;
  window.__rewire=function(){if(typeof prev==='function')prev();wire()};
})();
</script>`;
}

// Report chat: "Ask about it" Q&A + "Refine this search" re-run via /api/chat.
export function chatScript(slug) {
  return `<script nonce="__CSP_NONCE__">
(function(){
  function wire(){
    var form=document.getElementById('chat-form');
    if(!form||form.__wired)return;form.__wired=true;
    var input=document.getElementById('chat-input');
    var box=document.getElementById('chat-messages');
    var status=document.getElementById('chat-status');
    var slug=${JSON.stringify(slug).replace(/</g,'\\u003c')};
    var mode='ask';
    var askTranscript=[];
    var refineTranscript=[];
    var seeded={ask:false,refine:false};

    function bubble(role,text){
      var div=document.createElement('div');
      div.style.cssText='max-width:85%;padding:.55rem .8rem;border-radius:10px;font-size:.9rem;line-height:1.5;white-space:pre-wrap;'+(role==='user'
        ?'align-self:flex-end;background:color-mix(in srgb,var(--accent) 14%,transparent);color:var(--ink)'
        :'align-self:flex-start;background:var(--surface-2);color:var(--ink-2)');
      div.textContent=text;
      box.appendChild(div);
      box.scrollTop=box.scrollHeight;
      return div;
    }

    function seedIntro(){
      if(mode==='ask'&&!seeded.ask){
        bubble('assistant','Ask anything about this comparison \\u2014 why one ranked above another, which fits your situation, what to watch out for.');
        seeded.ask=true;
      }
      if(mode==='refine'&&!seeded.refine){
        bubble('assistant','Tell me what to change \\u2014 budget, use case, things to exclude \\u2014 and I\\u2019ll help you rerun the research with sharper constraints.');
        seeded.refine=true;
      }
    }

    function runRefinedResearch(query,refinements){
      if(status)status.textContent='Starting refined research\\u2026';
      fetch('/api/research',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({query:query,clarifications:refinements||{},fresh:true})
      }).then(function(r){return r.json()}).then(function(d){
        if(d.error){if(status)status.textContent=d.error;return;}
        if(d.slug){window.location.href='/research/'+d.slug;return;}
        if(d.id){window.location.href='/research/'+d.id;return;}
        if(status)status.textContent='Something went wrong. Try again.';
      }).catch(function(){if(status)status.textContent='Network error. Try again.'});
    }

    function actionBtn(label,query,refinements){
      var btn=document.createElement('button');
      btn.type='button';btn.className='btn';
      btn.style.cssText='align-self:flex-start;font-size:.82rem;padding:.5rem .85rem';
      btn.textContent=label;
      btn.addEventListener('click',function(){runRefinedResearch(query,refinements)});
      box.appendChild(btn);box.scrollTop=box.scrollHeight;
    }

    var chatTabs=document.querySelectorAll('[data-chat-tab]');
    function activateChatTab(name){
      mode=name;
      chatTabs.forEach(function(t){
        var active=t.dataset.chatTab===mode;
        t.setAttribute('aria-selected',active?'true':'false');
        t.setAttribute('tabindex',active?'0':'-1');
        t.style.background=active?'var(--accent-quiet)':'';
        t.style.borderColor=active?'var(--accent)':'';
        t.style.color=active?'var(--accent)':'';
      });
      box.innerHTML='';
      if(status)status.textContent='';
      input.placeholder=mode==='refine'
        ?'e.g. Narrow it to under $100, or focus on quiet models'
        :'e.g. Which one is best for a small apartment?';
      seedIntro();
    }
    chatTabs.forEach(function(tab,i){
      tab.setAttribute('tabindex',tab.getAttribute('aria-selected')==='true'?'0':'-1');
      tab.addEventListener('click',function(){activateChatTab(tab.dataset.chatTab)});
      tab.addEventListener('keydown',function(ev){
        var next=i;
        if(ev.key==='ArrowRight')next=(i+1)%chatTabs.length;
        else if(ev.key==='ArrowLeft')next=(i-1+chatTabs.length)%chatTabs.length;
        else if(ev.key==='Home')next=0;
        else if(ev.key==='End')next=chatTabs.length-1;
        else return;
        ev.preventDefault();
        activateChatTab(chatTabs[next].dataset.chatTab);
        chatTabs[next].focus();
      });
    });

    form.addEventListener('submit',function(ev){
      ev.preventDefault();
      var text=(input.value||'').trim();
      if(!text||form.__busy)return;
      form.__busy=true;input.value='';
      var transcript=mode==='refine'?refineTranscript:askTranscript;
      if(transcript.length>=14)transcript.splice(0,transcript.length-13);
      transcript.push({role:'user',content:text});
      bubble('user',text);
      var thinking=bubble('assistant','\\u2026');
      if(status)status.textContent='';
      var body={slug:slug,messages:transcript};
      if(mode==='refine')body.mode='refine';
      fetch('/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
        .then(function(r){var ct=r.headers.get('content-type')||'';if(ct.indexOf('application/json')===-1){throw new Error('non-json')}return r.json().then(function(d){return{ok:r.ok,d:d}})})
        .then(function(res){
          form.__busy=false;
          if(res.ok&&res.d&&res.d.reply){
            thinking.textContent=res.d.reply;
            transcript.push({role:'assistant',content:res.d.reply});
            if(mode==='refine'&&res.d.suggestedQuery){
              actionBtn('Run refined research: '+res.d.suggestedQuery,res.d.suggestedQuery,res.d.refinements);
            }else if(res.d.suggestedQuery){
              var f=document.createElement('form');
              f.method='POST';f.action='/research/new';
              f.style.cssText='align-self:flex-start;margin:0';
              var h=document.createElement('input');h.type='hidden';h.name='q';h.value=res.d.suggestedQuery;f.appendChild(h);
              var b=document.createElement('button');b.type='submit';b.className='btn';
              b.style.cssText='font-size:.82rem;padding:.5rem .85rem';
              b.textContent='Research: '+res.d.suggestedQuery;
              f.appendChild(b);box.appendChild(f);box.scrollTop=box.scrollHeight;
            }
          }else{
            thinking.remove();transcript.pop();
            if(status)status.textContent=(res.d&&res.d.error)||'Something went wrong. Try again.';
          }
        })
        .catch(function(){
          form.__busy=false;thinking.remove();transcript.pop();
          if(status)status.textContent='Network error. Try again.';
        });
    });
    seedIntro();
  }
  if(document.readyState==='loading'){document.addEventListener('DOMContentLoaded',wire)}else{wire()}
  var prev=window.__rewire;
  window.__rewire=function(){if(typeof prev==='function')prev();wire()};
})();
</script>`;
}
