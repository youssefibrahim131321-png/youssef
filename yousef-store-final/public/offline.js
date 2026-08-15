/* (إصلاح CSP) زر إعادة المحاولة في offline.html — سكربت خارجي بدل onclick
   inline اللي كان بيتحظر تحت CSP القائم على nonce. */
document.getElementById('retryBtn')?.addEventListener('click', function () {
  location.reload();
});
