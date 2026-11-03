import mongoose from 'mongoose';
import type { Connection } from 'mongoose';
export async function connect_database(uri: string): Promise<Connection> {
  const connection = await mongoose
    .createConnection(uri, { serverSelectionTimeoutMS: 10000, maxPoolSize: 20 })
    .asPromise();
  const hello = await connection.db!.admin().command({ hello: 1 });
  if (!hello.setName && !hello.msg) {
    await connection.close();
    throw new Error(
      'MongoDB must support transactions (replica set or mongos)',
    );
  }
  return connection;
}
