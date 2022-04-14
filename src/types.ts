export type LanguageOptionsType = {
  name: "sql" | "mysql" | "mariadb" | "postgresql";
};

export type MainOptionsType = {
  language: LanguageOptionsType;
};

export type QueryEventType = {
  timestamp: Date;
  query: string; // Query sent to the database
  params: string; // Query parameters
  duration: number; // Time elapsed (in milliseconds) between client issuing query and database responding - not only time taken to run query
  target: string;
  languageOptions?: LanguageOptionsType;
};

export type MessageType = QueryEventType & {
  id: string;
};
