import DataLoader from 'dataloader';
import { UseMiddleware } from 'type-graphql';
import Container from 'typedi';
import type { ObjectType, Connection, SelectQueryBuilder } from 'typeorm';
import { RelationMetadata } from 'typeorm/metadata/RelationMetadata';
import { ColumnMetadata } from 'typeorm/metadata/ColumnMetadata';
import { keyBy, groupBy, Dictionary, omit } from 'lodash';
import { TgdContext } from '#/types/TgdContext';

type KeyFunc = (root: any) => any | any[] | undefined;

type GetQueryFunc<V> = (query: SelectQueryBuilder<V>) => SelectQueryBuilder<V>;

interface TypeormLoaderOption {
  selfKey: boolean;
}

export function TypeormLoader<V>({
  getKey,
  getQuery,
  options,
}: {
  getKey: KeyFunc;
  getQuery?: GetQueryFunc<V>;
  getType?: (type?: void) => ObjectType<V>;
  options?: TypeormLoaderOption;
}): PropertyDecorator {
  return TypeormLoaderImpl<V>({
    getQuery,
    keyFunc: getKey,
    option: options,
  });
}

function TypeormLoaderImpl<V>({
  getQuery,
  keyFunc,
  option,
}: {
  getQuery?: GetQueryFunc<V>;
  keyFunc: KeyFunc;
  option?: TypeormLoaderOption;
}): PropertyDecorator {
  return (target: Object, propertyKey: string | symbol) => {
    UseMiddleware(async ({ root, context }, next) => {
      const tgdContext = context._tgdContext as TgdContext;
      if (tgdContext.typeormGetConnection == null) {
        throw Error('typeormGetConnection is not set');
      }
      const relation = tgdContext
        .typeormGetConnection()
        .getMetadata(target.constructor)
        .findRelationWithPropertyPath(propertyKey.toString());

      if (relation == null) {
        return await next();
      }
      if (
        option?.selfKey &&
        !(relation.isOneToMany || relation.isOneToOneNotOwner)
      ) {
        throw Error(
          'selfKey option is available only for OneToMany or OneToOneNotOwner',
        );
      }

      // prettier-ignore
      const handle =
        relation.isManyToOne || relation.isOneToOneOwner ?
          handleToOne :
        relation.isOneToMany ?
          option?.selfKey ?
            handleOneToManyWithSelfKey :
          handleToMany :
        relation.isOneToOneNotOwner ?
          option?.selfKey ?
            handleOneToOneNotOwnerWithSelfKey :
          handleToOne :
        relation.isManyToMany ?
          handleToMany :
        () => next();
      return await handle<V>(keyFunc, root, tgdContext, relation, getQuery);
    })(target, propertyKey);
  };
}

async function handler<V>(
  { requestId, typeormGetConnection }: TgdContext,
  relation: RelationMetadata,
  columns: ColumnMetadata[],
  newDataloader: (connection: Connection) => DataLoader<any, V>,
  callback: (
    dataloader: DataLoader<any, V>,
    columns: ColumnMetadata[],
  ) => Promise<any>,
) {
  if (typeormGetConnection == null) {
    throw Error('Connection is not available');
  }

  if (columns.length !== 1) {
    throw Error('Loading by multiple columns as foreign key is not supported.');
  }

  const serviceId = `tgd-typeorm#${relation.entityMetadata.tableName}#${relation.propertyName}`;
  const container = Container.of(requestId);
  if (!container.has(serviceId)) {
    container.set(serviceId, newDataloader(typeormGetConnection()));
  }

  return callback(container.get<DataLoader<any, any>>(serviceId), columns);
}

async function handleToMany<V>(
  foreignKeyFunc: (root: any) => any | undefined,
  root: any,
  tgdContext: TgdContext,
  relation: RelationMetadata,
  getQuery?: GetQueryFunc<V>,
) {
  return handler(
    tgdContext,
    relation,
    relation.inverseEntityMetadata.primaryColumns,
    connection => new ToManyDataloader<V>(relation, connection, getQuery),
    async dataloader => {
      // ?? [] fixes many-to-many @RelationId results to undefined
      // when it fetches in time of entity creation
      // could lead to potenial bug with missing
      // data on that fetch
      // that probably @RelationId bug itself
      // but its ok foor now
      const fks = foreignKeyFunc(root) ?? [];
      return await dataloader.loadMany(fks ?? []);
    },
  );
}

async function handleToOne<V>(
  foreignKeyFunc: (root: any) => any | undefined,
  root: any,
  tgdContext: TgdContext,
  relation: RelationMetadata,
  getQuery?: GetQueryFunc<V>,
) {
  return handler(
    tgdContext,
    relation,
    relation.inverseEntityMetadata.primaryColumns,
    connection => new ToOneDataloader<V>(relation, connection, getQuery),
    async dataloader => {
      const fk = foreignKeyFunc(root);
      return fk != null ? await dataloader.load(fk) : null;
    },
  );
}
async function handleOneToManyWithSelfKey<V>(
  selfKeyFunc: (root: any) => any | any[],
  root: any,
  tgdContext: TgdContext,
  relation: RelationMetadata,
  getQuery?: GetQueryFunc<V>,
) {
  return handler(
    tgdContext,
    relation,
    relation.entityMetadata.primaryColumns,
    connection =>
      new SelfKeyDataloader<V>(relation, connection, selfKeyFunc, getQuery),
    async (dataloader, columns) => {
      const pk = columns[0].getEntityValue(root);
      return await dataloader.load(pk);
    },
  );
}

async function handleOneToOneNotOwnerWithSelfKey<V>(
  selfKeyFunc: (root: any) => any | undefined,
  root: any,
  tgdContext: TgdContext,
  relation: RelationMetadata,
  getQuery?: GetQueryFunc<V>,
) {
  return handler(
    tgdContext,
    relation,
    relation.entityMetadata.primaryColumns,
    connection =>
      new SelfKeyDataloader<V>(relation, connection, selfKeyFunc, getQuery),
    async (dataloader, columns) => {
      const pk = columns[0].getEntityValue(root);
      return (await dataloader.load(pk))[0] ?? null;
    },
  );
}
function directLoader<V>(
  relation: RelationMetadata,
  connection: Connection,
  grouper: string | ((entity: V) => any),
  getQuery?: GetQueryFunc<V>,
) {
  return async (ids: readonly any[]) => {
    const query = connection
      .createQueryBuilder<V>(relation.type, relation.propertyName)
      .whereInIds(ids);

    const entities = keyBy(
      await (getQuery?.(query) ?? query).getMany(),
      grouper,
    ) as Dictionary<V>;
    return ids.map(id => entities[id]);
  };
}

class ToManyDataloader<V> extends DataLoader<any, V> {
  constructor(
    relation: RelationMetadata,
    connection: Connection,
    getQuery?: GetQueryFunc<V>,
  ) {
    super(
      directLoader(
        relation,
        connection,
        entity =>
          relation.inverseEntityMetadata.primaryColumns[0].getEntityValue(
            entity,
          ),
        getQuery,
      ),
    );
  }
}

class ToOneDataloader<V> extends DataLoader<any, V> {
  constructor(
    relation: RelationMetadata,
    connection: Connection,
    getQuery?: GetQueryFunc<V>,
  ) {
    super(
      directLoader(
        relation,
        connection,
        relation.inverseEntityMetadata.primaryColumns[0].propertyName,
      ),
    );
  }
}

class SelfKeyDataloader<V> extends DataLoader<any, V[]> {
  constructor(
    relation: RelationMetadata,
    connection: Connection,
    selfKeyFunc: (root: any) => any,
    getQuery?: GetQueryFunc<V>,
  ) {
    super(async ids => {
      const columns = relation.inverseRelation!.joinColumns;
      const k = `${relation.propertyName}_${columns[0].propertyName}`;
      const query = connection
        .createQueryBuilder<V>(relation.type, relation.propertyName)
        .where(
          `${relation.propertyName}.${columns[0].propertyPath} IN (:...${k})`,
        )
        .setParameter(k, ids);

      const entities = groupBy(
        await (getQuery?.(query) ?? query).getMany(),
        selfKeyFunc,
      );
      return ids.map(id => entities[id] ?? []);
    });
  }
}
