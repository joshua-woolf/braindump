const error = new URLSearchParams(location.search).get("error");
if (error) document.getElementById("status").textContent = error;
