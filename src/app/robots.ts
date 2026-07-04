import type { MetadataRoute } from "next";

/** Закрываем весь сайт от индексации поисковиками (внутренний сервис). */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      disallow: "/",
    },
  };
}
