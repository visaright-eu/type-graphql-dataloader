import type { ObjectType, SelectQueryBuilder } from 'typeorm';
declare type KeyFunc = (root: any) => any | any[] | undefined;
declare type GetQueryFunc<V> = (query: SelectQueryBuilder<V>) => SelectQueryBuilder<V>;
interface TypeormLoaderOption {
    selfKey: boolean;
}
export declare function TypeormLoader<V>({ getKey, getQuery, options, }: {
    getKey: KeyFunc;
    getQuery?: GetQueryFunc<V>;
    getType?: (type?: void) => ObjectType<V>;
    options?: TypeormLoaderOption;
}): PropertyDecorator;
export {};
