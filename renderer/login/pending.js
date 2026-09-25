(() => {
  document.getElementById('btn-min').addEventListener('click', () => window.ncdai.minimize());
  document.getElementById('btn-close').addEventListener('click', () => window.ncdai.close());

  // ---------- Decorative candle animation (no network needed — this is just
  // a "we're working on it" indicator, not a real market feed like the
  // installer's chart panel) ----------
  startCandleAnimation(document.getElementById('pending-chart'));

  function startCandleAnimation(canvas) {
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;
    const candleWidth = 3;
    const gap = 2;
    const maxCandles = Math.floor(w / (candleWidth + gap));
    const upColor = '#17c288';
    const downColor = '#e5484d';

    let lastClose = h / 2;
    const candles = [];

    function nextCandle(prevClose) {
      const volatility = h * 0.22;
      const open = prevClose;
      let close = open + (Math.random() - 0.5) * volatility * 2;
      close = Math.max(3, Math.min(h - 3, close));
      const bodyTop = Math.min(open, close);
      const bodyBottom = Math.max(open, close);
      const high = Math.max(1, bodyTop - Math.random() * volatility * 0.4);
      const low = Math.min(h - 1, bodyBottom + Math.random() * volatility * 0.4);
      return { open, close, high, low };
    }

    for (let i = 0; i < maxCandles; i++) {
      const c = nextCandle(lastClose);
      candles.push(c);
      lastClose = c.close;
    }

    function draw() {
      ctx.clearRect(0, 0, w, h);
      candles.forEach((c, i) => {
        const x = i * (candleWidth + gap) + 1;
        const isUp = c.close <= c.open; // smaller y = higher price on screen
        ctx.strokeStyle = ctx.fillStyle = isUp ? upColor : downColor;
        ctx.lineWidth = 1;

        ctx.beginPath();
        ctx.moveTo(x + candleWidth / 2, c.high);
        ctx.lineTo(x + candleWidth / 2, c.low);
        ctx.stroke();

        const bodyTop = Math.min(c.open, c.close);
        const bodyHeight = Math.max(1, Math.abs(c.close - c.open));
        ctx.fillRect(x, bodyTop, candleWidth, bodyHeight);
      });
    }

    draw();
    setInterval(() => {
      const c = nextCandle(lastClose);
      lastClose = c.close;
      candles.push(c);
      if (candles.length > maxCandles) candles.shift();
      draw();
    }, 650);
  }

  // Approval isn't announced here — main.js just navigates the whole window to
  // the shell once the poll sees "approved". Rejection, though, has to be shown
  // on THIS screen (nowhere else to show it), so we listen for that push.
  window.ncdai.onRegistrationStatus(({ status }) => {
    if (status === 'rejected') {
      document.getElementById('pending-status').hidden = true;
      document.getElementById('pending-rejected').hidden = false;
    }
  });

  document.getElementById('btn-back-to-login').addEventListener('click', () => {
    window.ncdai.backToLogin();
  });

  // ---------- Ping ----------
  const pingDot = document.getElementById('ping-dot');
  const pingValue = document.getElementById('ping-value');
  window.ncdai.onPingStatus(({ ok, ms }) => {
    if (!ok) {
      pingDot.className = 'ping-dot is-red';
      pingValue.textContent = 'нет связи';
      return;
    }
    const level = ms <= 20 ? 'green' : ms <= 100 ? 'orange' : 'red';
    pingDot.className = `ping-dot is-${level}`;
    pingValue.textContent = `${ms} мс`;
  });
})();
