let expiryTimer;
document.getElementById("phone-link").onclick = async function () {
  const output = document.getElementById("phone-link-result");
  this.disabled = true;
  try {
    let token = "";
    try { token = localStorage.getItem("a1-scout-token") || ""; } catch {}
    const response = await fetch("/api/phone-link", { method: "POST", credentials: "same-origin", headers: token ? { authorization: `Bearer ${token}` } : {} });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Couldn't make a link");
    const qr = qrcode(0, "M"); qr.addData(result.url); qr.make();
    output.replaceChildren();
    const image = document.createElement("div"); image.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 16, scalable: true });
    image.style.cssText = "width:240px;max-width:100%;background:white;margin:16px 0";
    const link = document.createElement("a"); link.href = result.url; link.textContent = "Open single-use sign-in link";
    const note = document.createElement("p"); note.textContent = "Scan with your iPhone camera. Expires in 10 minutes. Anyone with this link can sign in once; keep it private.";
    output.append(image, link, note);
    clearTimeout(expiryTimer);
    expiryTimer = setTimeout(() => { output.textContent = "Link expired. Create a new one."; }, Math.max(0, Date.parse(result.expires_at) - Date.now()));
  } catch (error) { output.textContent = error.message; }
  finally { this.disabled = false; }
};
