import { useState } from "react";
import { Globe2 } from "lucide-react";

export function SiteIcon({ id }: { id: string }) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  return (
    <span className="site-icon" aria-hidden="true">
      {!loaded && <Globe2 size={18} />}
      {!failed && (
        <img
          src={`/api/links/${id}/favicon`}
          alt=""
          width={20}
          height={20}
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          className={loaded ? "" : "opacity-0"}
          onLoad={() => setLoaded(true)}
          onError={() => {
            setFailed(true);
            setLoaded(false);
          }}
        />
      )}
    </span>
  );
}
