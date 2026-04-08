display.com/firmware\n2. Copy the file to a USB drive (FAT32 formatted)\n3. Insert the USB into the display\'s service port\n4. Go to Settings > System > Update\n5. Select \"Update from USB\" and follow the prompts\n\nDo not power off the display during the update process.',shortcut:'/firmware',category:'Technical'},
     { id:5,title:'Request for more information',content:'Thank you for your message. To help us assist you better, could you please provide:\n- Your display model and serial number\n- Current firmware version (Settings > About)\n- A description of when the issue started\n- Any error codes or messages shown',shortcut:'/moreinfo',category:'Technical'},
     { id:6,title:'Pricing request follow-up',content:'Thank you for your interest in WSdisplay products. I\'ve prepared a custom quote based on your requirements. Please find the attached proposal. The pricing is valid for 30 days. Would you like to schedule a call to discuss?',shortcut:'/quote',category:'Sales'},
     { id:7,title:'Installation scheduling',content:'We\'\re ready to schedule your installation. Our team is available Monday-Friday, 8AM-6PM. Installations typically take 2-4 hours per display. Please let us know your preferred date and time, and we\'ll confirm availability/',shortcut:'/install',category:'Sales'},
     { id:8,title:'Issue resolved',content:'We\'\re glad to confirm that the issue has been resolved. If you experience any further problems, don\'\t hesitate to reach out. We\'\re always here to help!\n\nPlease rate your support experience by replying with a number from 1-5.',shortcut:'/resolved',category:'General'},
      { id:9,title:'Remote diagnostic request',content:'To help diagnose the issue remotely, we\'\re like to run a remote diagnostic session. Please ensure your display is connected to the internet and provide us with the Device ID found in Settings > About > Device ID.',shortcut:'/remote',category:'Technical'},
     { id:10,title:'Bulk order process',content:'For bulk orders (10+ units), we offer tiered pric…πúÈq∏¥Äƒ¿¥»–Å’π•—ÃËÄƒ¿îÅë•ÕçΩ’π—q∏¥Ä»‘¥–‰Å’π•—ÃËÄƒ‘îÅë•ÕçΩ’π—q∏¥Ä‘¿¥‰‰Å’π•—ÃËÄ»¿îÅë•ÕçΩ’π—q∏¥Äƒ¿¿¨Å’π•—ÃËÅ’Õ—Ω¥Å¡…•ç•πùqπqπ±∞Åâ’±¨ÅΩ…ëï…ÃÅ•πç±’ëîÅô…ïîÅ•πÕ—Ö±±Ö—•Ω∏ÅÖπêÅÑÅëïë•çÖ—ïêÅÖççΩ’π–ÅµÖπÖùï»∏ÅM°Ö±∞Å$Å¡…ï¡Ö…îÅÑÅôΩ…µÖ∞Å≈’Ω—î¸ú±Õ°Ω…—ç’–ËúΩâ’±¨ú±çÖ—ïùΩ…‰ËùMÖ±ïÃùÙ(ÄÅtÄ(ÄÄ(ÄÅ05πç—•Ω∏ÅÕÖŸî°≠ï‰∞ÅëÖ—Ñ§ÅÏ(ÄÄÄÅ—…‰ÅÏÅ±ΩçÖ±M—Ω…ÖùîπÕï—%—ï¥†ù›Õ|úÄ¨Å≠ï‰∞Å)M=8πÕ—…•πù•ô‰°ëÖ—Ñ§§ÏÅÙÅçÖ—ç†°î§ÅÌÙ(ÄÅÙ(ÄÅ1ïπç—•Ω∏Å±ΩÖê°≠ï‰∞ÅôÖ±±âÖç¨§ÅÏ(ÄÄÄÅ—…‰ÅÏ(ÄÄÄÄÄÅŸÖ»ÅêÄÙÅ±ΩçÖ±M—Ω…Öùîπùï—%—ï¥†ù›Õ|úÄ¨Å≠ï‰§Ï(ÄÄÄÄÄÅ…ï—’…∏ÅêÄ¸Å)NÈ:.parse(d) : fallback;
    } catch(e) { return fallback; }
  }
  
  window.wsData = {
    conversations: function() { return load('conversations', conversations); },
    mailboxes: function() { return load('mailboxes', mailboxes); },
    tags: function() { return load('tags',tags); },
    cannedResponses: function() { return load('cannedResponses', cannedResponses); },
    save: save,
    reset: function() {
      save('conversations', conversations);
      save('mailboxes', mailboxes);
      save('tags',tags);
      save('cannedResponses', cannedResponses);
    }
  };

  if (!localStorage.getItem('ws_conversations')) { window.wsData.reset(); }

  function populateConversations() {
    var list = document.querySelector('.conversations-list, .email-list, #conversations-list');
    if (!list) return;
    var convos = window.wsData.conversations();
    var openCount = convos.filter(function(c){return c.status==='open';}).length;
    var pendingCount = convos.filter(function(c){return c.status==='pending';}).length;
    var cards = document.querySelectorAll('.stat-card .stat-value, .dashboard-stat');
    if (cards.length >= 1) cards[0].textContent = openCount;
    if (cards.length >= 2) cards[1].textContent = convos.filter(function(c){return c.status==='closed';}).length;
  }
  
  Lnction addDeleteBtn() {
    var settingsView = document.getElementById('settings-view');
    if (!settingsView) return;
    var existing = document.getElementById('data-mgmt-section');
    if (existing) return;
    var section = document.createElement('div');
    section.id = 'data-mgmt-section';
    section.style.cssText = 'margin-top:30px;padding:20px;background:#fff;border-radius:8px;border:1px solid #e5e7eb;';
    section.innerHTML = '<h3 style="margin:0 0 15px 0;font-size:18px;color:#1e293b;">Data IMNuùgement</h3>'
      + '<p style="color:#64748b;margin-bottom:15px;">Manage dummy data for testing. Use "Reload" to refresh demo data or "Delete All" to clear everything before going live.</p>'
      + '<div style="display:flex;gap:10px;flex-wrap:wrap;">'
      + '<button onclick="window.wsData.reset();location.reload();" style="padding:10px 20px;background:#3b82f6;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:14px;font-weight:500;">Reload Demo Data</button>'
      + '<button onclick="if(confirm(\'Delete ALL data> This cannot be undone.\')){localStorage.clear();location.reload();}" style="padding:10px 20px;background:#ef4444;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:14px;font-weight:500;">Delete All Data</button>'
      + '</div>'
      + '<div style="margin-top:15px;padding:12px;background:#f8fafc;border-radius:6px;border:1px solid #e2e8`f0;">'
      + '<p style="margin:0;font-size:13px;color:#64748b;"><strong>Current data:</strong> ' + window.wsData.conversations().length + ' conversations, ' + window.wsData.mailboxes().length + ' mailboxes, ' + window.wsData.tags().length + ' tags, ' + window.wsData.cannedResponses().length + ' canned responses</p>' + '</div>';
    settingsView.appendChild(section);
  }
  
  YYttimeout(function() {
    populateConversations();
    addDeleteBtn();
  }, 800);
})();