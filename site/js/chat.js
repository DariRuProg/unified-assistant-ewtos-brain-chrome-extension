/* ewtos — Hero-Chat-Animation: Chat mit dem Office-Vault (Office-Brain). @author Dario | ewtos.com */
(function () {
  var msgs = document.getElementById('heroChatMsgs');
  if (!msgs) return;
  var sequence = [
    { type: 'assistant', text: 'Laut kunden/meierhoff.md ist der Go-Live am 14. Juli. Die Freigabe der Startseite steht noch aus — Deadline dafür ist der 7. Juli.' },
    { type: 'user', text: 'Und wie war unser Ablauf fürs Live-Schalten?' },
    { type: 'assistant', text: 'In prozesse/relaunch-checkliste.md: 1) Staging-Freigabe, 2) DNS 48 h vorher umstellen, 3) Redirects prüfen, 4) Cache leeren, 5) Search Console neu einreichen.' },
    { type: 'user', text: 'Perfekt, danke.' }
  ];
  var i = 0;
  function next() {
    if (i >= sequence.length) return;
    var m = sequence[i++];
    var div = document.createElement('div');
    div.className = 'msg' + (m.type === 'user' ? ' user' : '');
    div.innerHTML = m.type === 'user'
      ? '<div class="msg-av user-av">Du</div><div class="msg-bubble user">' + m.text + '</div>'
      : '<div class="msg-av">OB</div><div class="msg-bubble bot">' + m.text + '</div>';
    div.style.opacity = '0';
    msgs.appendChild(div);
    msgs.scrollTop = msgs.scrollHeight;
    setTimeout(function () { div.style.transition = 'opacity 0.3s'; div.style.opacity = '1'; }, 50);
    setTimeout(next, 2200);
  }
  setTimeout(next, 1600);
})();
